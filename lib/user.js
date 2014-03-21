var Logger = require("./logger");
var Server = require("./server");
var util = require("./utilities");
var MakeEmitter = require("./emitter");
var db = require("./database");
var InfoGetter = require("./get-info");
var Config = require("./config");
var ACP = require("./acp");
var Account = require("./account");

function User(socket) {
    var self = this;
    MakeEmitter(self);
    self.flags = 0;
    self.socket = socket;
    self.ip = socket._ip;
    self.account = Account.default(self.ip);
    self.channel = null;
    self.queueLimiter = util.newRateLimiter();
    self.chatLimiter = util.newRateLimiter();
    self.awaytimer = false;

    self.on("ready", function () {
        var announcement = Server.getServer().announcement;
        if (announcement != null) {
            self.socket.emit("announcement", announcement);
        }

        self.socket.once("initChannelCallbacks", function () {
            self.initChannelCallbacks();
        });

        self.socket.once("initUserPLCallbacks", function () {
            self.initUserPLCallbacks();
        });

        self.socket.once("initACP", function () {
            self.whenLoggedIn(function () {
                if (self.account.globalRank >= 255) {
                    ACP.init(self);
                } else {
                    self.kick("Attempted initACP from non privileged user.  This incident " +
                              "will be reported.");
                    Logger.eventlog.log("[acp] Attempted initACP from socket client " +
                                        self.getName() + "@" + self.ip);
                }
            });
        });

        self.socket.on("login", function (data) {
            data = (typeof data === "object") ? data : {};

            var name = data.name;
            if (typeof name !== "string") {
                return;
            }

            var pw = data.pw || "";
            if (typeof pw !== "string") {
                pw = "";
            }

            if (self.is(User.LOGGING_IN) || self.is(User.LOGGED_IN)) {
                return;
            }

            if (!pw) {
                self.guestLogin(name);
            } else {
                self.login(name, pw);
            }
        });

        self.on("login", function (account) {
            if (account.globalRank >= 255) {
                self.initAdminCallbacks();
            }
        });
    });
}


/* User flags */
User.READY      = 1 << 0;
User.LOGGING_IN = 1 << 1;
User.LOGGED_IN  = 1 << 2;
User.AFK        = 1 << 3;
User.MUTED      = 1 << 4;
User.SMUTED     = 1 << 5;
User.IN_CHANNEL = 1 << 6;

User.prototype.is = function (flag) {
    return Boolean(this.flags & flag);
};

User.prototype.setFlag = function (flag) {
    this.flags &= flag;
    this.emit("setFlag", flag);
};

User.prototype.clearFlag = function (flag) {
    this.flags &= ~flag;
    this.emit("clearFlag", flag);
};

User.prototype.waitFlag = function (flag, cb) {
    var self = this;
    if (self.is(flag)) {
        cb();
    } else {
        var wait = function () {
            if (self.is(flag)) {
                self.unbind("setFlag", wait);
                cb();
            }
        };
        self.on("setFlag", wait);
    }
};

User.prototype.getName = function () {
    return this.account.name;
};

User.prototype.getLowerName = function () {
    return this.account.lowername;
};

User.prototype.inChannel = function () {
    return this.channel != null && !this.channel.dead;
};

/* Called when a user's AFK status changes */
User.prototype.setAFK = function (afk) {
    if (!this.inChannel()) {
        return;
    }

    /* No change in AFK status, don't need to change anything */
    if (this.is(User.AFK) === afk) {
        return;
    }

    if (afk) {
        this.setFlag(User.AFK);
        if (chan.voteskip) {
            chan.voteskip.unvote(this.ip);
        }
    } else {
        this.clearFlag(User.AFK);
        this.autoAFK();
    }

    /* Number of AFK users changed, voteskip state changes */
    chan.checkVoteskipPass();
    chan.sendAll("setAFK", {
        name: this.getName(),
        afk: afk
    });
};

/* Automatically tag a user as AFK after a period of inactivity */
User.prototype.autoAFK = function () {
    var self = this;
    if (self.awaytimer) {
        clearTimeout(self.awaytimer);
    }

    if (!self.inChannel()) {
        return;
    }

    /* Don't set a timer if the duration is invalid */
    var timeout = parseFloat(self.channel.opts.afk_timeout);
    if (isNaN(timeout) || timeout <= 0) {
        return;
    }

    self.awaytimer = setTimeout(function () {
        self.setAFK(true);
    }, timeout * 1000);
};

User.prototype.kick = function (reason) {
    this.socket.emit("kick", { reason: reason });
    this.socket.disconnect(true);
};

/* Init channel-related socket handlers */
User.prototype.initChannelCallbacks = function () {
    var self = this;

    /* Verifies datatype before calling a function
       Passes a default value if the typecheck fails */
    var typecheck = function (type, def, fn) {
        return function (data) {
            if (typeof data !== type) {
                fn(def);
            } else {
                fn(data);
            }
        };
    };

    // Verify that the user is in a channel, and that the passed data is an Object
    var wrapTypecheck = function (msg, fn) {
        self.socket.on(msg, typecheck("object", {}, function (data) {
            if (self.inChannel()) {
                fn(data);
            }
        }));
    };

    // Verify that the user is in a channel, but don't typecheck the data
    var wrap = function (msg, fn) {
        self.socket.on(msg, function (data) {
            if (self.inChannel()) {
                fn(data);
            }
        });
    };

    self.socket.on("disconnect", function () {
        if (self.awaytimer) {
            clearTimeout(self.awaytimer);
        }

        if (self.inChannel()) {
            self.channel.part(self);
        }
    });

    /* Only accept one joinChannel message */
    self.socket.once("joinChannel", typecheck("object", {}, function (data) {
        if (self.inChannel()) {
            return;
        }

        if (typeof data.name !== "string") {
            return;
        }

        if (!util.isValidChannelName(data.name)) {
            self.socket.emit("errorMsg", {
                msg: "Invalid channel name.  Channel names may consist of 1-30 " +
                     "characters in the set a-z, A-Z, 0-9, -, and _"
            });
            self.kick("Invalid channel name");
            return;
        }

        data.name = data.name.toLowerCase();
        var chan = Server.getServer().getChannel(data.name);
        chan.preJoin(self, data.pw);
    }));

    wrapTypecheck("assignLeader", function (data) {
        self.channel.handleChangeLeader(self, data);
    });

    wrapTypecheck("setChannelRank", function (data) {
        self.channel.handleSetRank(self, data);
    });

    wrapTypecheck("unban", function (data) {
        self.channel.handleUnban(self, data);
    });

    wrapTypecheck("chatMsg", function (data) {
        if (typeof data.msg !== "string") {
            return;
        }

        if (data.msg.indexOf("/afk") !== 0) {
            self.setAFK(false);
            self.autoAFK();
        }

        self.channel.handleChat(self, data);
    });

    wrapTypecheck("pm", function (data) {
        if (typeof data.msg !== "string" || typeof data.to !== "string") {
            return;
        }

        self.channel.handlePm(self, data);
    });

    wrapTypecheck("newPoll", function (data) {
        self.channel.handleOpenPoll(self, data);
    });

    wrapTypecheck("vote", function (data) {
        self.channel.handlePollVote(self, data);
    });

    wrap("closePoll", function () {
        self.channel.handleClosePoll(self);
    });

    wrap("playerReady", function () {
        self.channel.sendMediaUpdate([self]);
    });

    wrap("requestPlaylist", function () {
        self.channel.sendPlaylist([self]);
    });

    wrapTypecheck("queue", function (data) {
        self.channel.handleQueue(self, data);
    });

    wrapTypecheck("queuePlaylist", function (data) {
        self.channel.handleQueuePlaylist(self, data);
    });

    wrapTypecheck("setTemp", function (data) {
        self.channel.handleSetTemp(self, data);
    });

    wrapTypecheck("moveMedia", function (data) {
        self.channel.handleMove(self, data);
    });

    wrap("delete", function (data) {
        self.channel.handleDelete(self, data);
    });

    wrapTypecheck("uncache", function (data) {
        self.channel.handleUncache(self, data);
    });

    wrap("jumpTo", function (data) {
        self.channel.handleJumpTo(self, data);
    });

    wrap("playNext", function () {
        self.channel.handlePlayNext(self);
    });

    wrap("clearPlaylist", function () {
        self.channel.handleClear(self);
    });

    wrap("shufflePlaylist", function () {
        self.channel.handleShuffle(self);
    });

    wrap("togglePlaylistLock", function () {
        self.channel.handleToggleLock(self);
    });

    wrapTypecheck("mediaUpdate", function (data) {
        self.channel.handleUpdate(self, data);
    });

    wrapTypecheck("searchMedia", function (data) {
        if (typeof data.query !== "string") {
            return;
        }
        data.query = data.query.substring(0, 255);

        var searchYT = function () {
            InfoGetter.Getters.ytSearch(data.query.split(" "), function (e, vids) {
                if (!e) {
                    self.socket.emit("searchResults", {
                        source: "yt",
                        results: vids
                    });
                }
            });
        };

        if (data.source === "yt") {
            searchYT();
        } else {
            self.channel.search(data.query, function (vids) {
                if (vids.length === 0) {
                    searchYT();
                } else {
                    self.socket.emit("searchResults", {
                        source: "library",
                        results: vids
                    });
                }
            });
        }

    });

    wrapTypecheck("setOptions", function (data) {
        self.channel.handleUpdateOptions(self, data);
    });

    wrapTypecheck("setPermissions", function (data) {
        self.channel.handleSetPermissions(self, data);
    });

    wrapTypecheck("setChannelCSS", function (data) {
        self.channel.handleSetCSS(self, data);
    });

    wrapTypecheck("setChannelJS", function (data) {
        self.channel.handleSetJS(self, data);
    });

    wrapTypecheck("setMotd", function (data) {
        self.channel.handleSetMotd(self, data);
    });

    wrapTypecheck("updateFilter", function (data) {
        self.channel.handleUpdateFilter(self, data);
    });

    wrap("importFilters", function (data) {
        self.channel.handleImportFilters(self, data);
    });

    // REMOVE FILTER
    // https://www.youtube.com/watch?v=SxUU3zncVmI
    wrapTypecheck("removeFilter", function (data) {
        self.channel.handleRemoveFilter(self, data);
    });

    wrapTypecheck("moveFilter", function (data) {
        self.channel.handleMoveFilter(self, data);
    });

    wrapTypecheck("updateEmote", function (data) {
        self.channel.handleUpdateEmote(self, data);
    });

    wrap("importEmotes", function (data) {
        self.channel.handleImportEmotes(self, data);
    });

    wrapTypecheck("removeEmote", function (data) {
        self.channel.handleRemoveEmote(self, data);
    });

    wrap("requestBanlist", function () {
        self.channel.sendBanlist([self]);
    });

    wrap("requestChannelRanks", function () {
        self.channel.sendChannelRanks([self]);
    });

    wrap("requestChatFilters", function () {
        self.channel.sendChatFilters([self]);
    });

    wrap("voteskip", function () {
        self.channel.handleVoteskip(self);
    });

    wrap("readChanLog", function () {
        self.channel.handleReadLog(self);
    });
};

User.prototype.initAdminCallbacks = function () {
    var self = this;
    self.socket.on("borrow-rank", function (rank) {
        if (self.inChannel()) {
            if (typeof rank !== "number") {
                return;
            }

            if (rank > self.account.globalRank) {
                return;
            }

            if (rank === 255 && self.account.globalRank > 255) {
                rank = self.account.globalRank;
            }

            self.account.channelRank = rank;
            self.socket.emit("rank", rank);
            self.channel.sendAll("setUserRank", {
                name: self.getName(),
                rank: rank
            });
        }
    });
};

User.prototype.login = function (name, pw) {
    var self = this;
    self.loggingIn = true;

    db.users.verifyLogin(name, pw, function (err, user) {
        self.loggingIn = false;
        if (err) {
            if (err === "Invalid username/password combination") {
                Logger.eventlog.log("[loginfail] Login failed (bad password): " + name
                                  + "@" + webserver.ipForRequest(req));
            }

            self.socket.emit("login", {
                success: false,
                error: err
            });
            return;
        }

        var opts = {};
        if (self.inChannel()) {
            opts.channel = self.channel.name;
        }
        Account.getAccount(user.name, self.ip, opts, function (err, account) {
            if (err) {
                Logger.errlog.log("[SEVERE] getAccount failed for user " + user.name);
                return;
            }
            self.account = account;
            self.socket.emit("login", {
                success: true,
                name: user.name
            });
            self.socket.emit("rank", self.account.effectiveRank);
            Logger.syslog.log(self.ip + " logged in as " + name);
            if (self.inChannel()) {
                // TODO s/ip/hostmask
                self.channel.logger.log(self.ip + " logged in as " + name);
            }
            self.setFlag(User.LOGGED_IN);
            self.emit("login", self.account);
        });
    });
};

var lastguestlogin = {};
User.prototype.guestLogin = function (name) {
    // TODO you shouldn't be able to guest login without being in a channel
    var self = this;

    if (self.ip in lastguestlogin) {
        var diff = (Date.now() - lastguestlogin[self.ip]) / 1000;
        if (diff < Config.get("guest-login-delay")) {
            self.socket.emit("login", {
                success: false,
                error: "Guest logins are restricted to one per IP address per " +
                       Config.get("guest-login-delay") + " seconds."
            });
            return;
        }
    }

    if (!util.isValidUserName(name)) {
        self.socket.emit("login", {
            success: false,
            error: "Invalid username.  Usernames must be 1-20 characters long and " +
                   "consist only of characters a-z, A-Z, 0-9, -, _, and accented " +
                   "letters."
        });
        return;
    }

    // Prevent duplicate logins
    self.setFlag(User.LOGGING_IN);
    db.users.isUsernameTaken(name, function (err, taken) {
        self.clearFlag(User.LOGGING_IN);
        if (err) {
            self.socket.emit("login", {
                success: false,
                error: err
            });
            return;
        }

        if (taken) {
            self.socket.emit("login", {
                success: false,
                error: "That username is registered."
            });
            return;
        }

        if (self.inChannel()) {
            var nameLower = name.toLowerCase();
            for (var i = 0; i < self.channel.users.length; i++) {
                if (self.channel.users[i].getLowerName() === nameLower) {
                    self.socket.emit("login", {
                        success: false,
                        error: "That name is already in use on this channel."
                    });
                    return;
                }
            }
        }

        // Login succeeded
        lastguestlogin[self.ip] = Date.now();

        var opts = {};
        if (self.inChannel()) {
            opts.channel = self.channel.name;
        }
        Account.getAccount(name, self.ip, opts, function (err, account) {
            if (err) {
                Logger.errlog.log("[SEVERE] getAccount failed for guest login " + name);
                return;
            }

            self.account = account;
            self.socket.emit("login", {
                success: true,
                name: name,
                guest: true
            });
            self.socket.emit("rank", 0);
            Logger.syslog.log(self.ip + " signed in as " + name);
            if (self.inChannel()) {
                // TODO s/ip/hostmask
                self.channel.logger.log(self.ip + " signed in as " + name);
            }
            self.setFlag(User.LOGGED_IN);
            self.emit("login", self.account);
        });
    });
};

User.prototype.initUserPLCallbacks = function () {
    require("./userplaylists").init(this);
};

module.exports = User;
