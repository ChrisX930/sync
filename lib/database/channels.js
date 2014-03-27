var db = require("../database");
var valid = require("../utilities").isValidChannelName;
var fs = require("fs");
var path = require("path");
var Logger = require("../logger");
var tables = require("./tables");

var blackHole = function () { };

function dropTable(name, callback) {
    db.query("DROP TABLE `" + name + "`", callback);
}

function initTables(name, owner, callback) {
    if (!valid(name)) {
        callback("Invalid channel name", null);
        return;
    }

    tables.createChannelTables(name, db.query.bind(db), function (err) {
        db.users.getGlobalRank(owner, function (err, rank) {
            if (err) {
                callback(err, null);
                return;
            }

            rank = Math.max(rank, 5);

            module.exports.setRank(name, owner, rank, function (err) {
                if (err) {
                    dropTable("chan_" + name + "_ranks");
                    dropTable("chan_" + name + "_ranks");
                    dropTable("chan_" + name + "_library");
                    callback(err, null);
                    return;
                }

                callback(null, true);
            });
        });
    });
}

module.exports = {
    init: function () {
    },

    /**
     * Checks if the given channel name is registered
     */
    isChannelTaken: function (name, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(name)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT name FROM `channels` WHERE name=?",
                     [name],
                     function (err, rows) {
            if (err) {
                callback(err, true);
                return;
            }
            callback(null, rows.length > 0);
        });
    },

    /**
     * Looks up a channel
     */
    lookup: function (name, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(name)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT * FROM `channels` WHERE name=?",
                     [name],
                     function (err, rows) {
            if (err) {
                callback(err, null);
                return;
            }

            if (rows.length === 0) {
                callback("No such channel", null);
            } else {
                callback(null, rows[0]);
            }
        });
    },

    /**
     * Searches for a channel
     */
    search: function (name, callback) {
        if (typeof callback !== "function") {
            return;
        }

        db.query("SELECT * FROM `channels` WHERE name LIKE ?",
                     ["%" + name + "%"],
                     function (err, rows) {
            if (err) {
                callback(err, null);
                return;
            }
            callback(null, rows);
        });
    },

    /**
     * Searches for a channel by owner
     */
    searchOwner: function (name, callback) {
        if (typeof callback !== "function") {
            return;
        }

        db.query("SELECT * FROM `channels` WHERE owner LIKE ?",
                     ["%" + name + "%"],
                     function (err, rows) {
            if (err) {
                callback(err, null);
                return;
            }
            callback(null, rows);
        });
    },

    /**
     * Validates and registers a new channel
     */
    register: function (name, owner, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (typeof name !== "string" || typeof owner !== "string") {
            callback("Name and owner are required for channel registration", null);
            return;
        }

        if (!valid(name)) {
            callback("Invalid channel name.  Channel names may consist of 1-30 " +
                     "characters a-z, A-Z, 0-9, -, and _", null);
            return;
        }

        module.exports.isChannelTaken(name, function (err, taken) {
            if (err) {
                callback(err, null);
                return;
            }

            if (taken) {
                callback("Channel name " + name + " is already taken", null);
                return;
            }

            db.query("INSERT INTO `channels` " +
                     "(`name`, `owner`, `time`) VALUES (?, ?, ?)",
                     [name, owner, Date.now()],
                     function (err, res) {
                if (err) {
                    callback(err, null);
                    return;
                }

                initTables(name, owner, function (err, res) {
                    if (err) {
                        db.query("DELETE FROM `channels` WHERE name=?", [name]);
                        callback(err, null);
                        return;
                    }
                    callback(null, {
                        name: name
                    });
                });
            });
        });
    },

    /**
     * Unregisters a channel
     */
    drop: function (name, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(name)) {
            callback("Invalid channel name", null);
            return;
        }

        dropTable("chan_" + name + "_ranks", function (err) {
            dropTable("chan_" + name + "_bans", function (e2) {
                if (err && e2) {
                    err += "\n" + e2;
                } else if (e2) {
                    err = e2;
                }

                dropTable("chan_" + name + "_library", function (e3) {
                    if (err && e3) {
                        err += "\n" + e3;
                    } else if (e3) {
                        err = e3;
                    }

                    db.query("DELETE FROM `channels` WHERE name=?", [name],
                    function (e4) {
                        if (err && e4) {
                            err += "\n" + e4;
                        } else if (e4) {
                            err = e4;
                        }

                        fs.unlink(path.join(__dirname, "..", "..", "chandump", name),
                                  function (err) {
                            if (err && err.code !== "ENOENT") {
                                Logger.errlog.log("Deleting chandump failed:");
                                Logger.errlog.log(err);
                            }
                        });

                        callback(err, !Boolean(err));
                    });
                });
            });
        });
    },

    /**
     * Looks up channels registered by a given user
     */
    listUserChannels: function (owner, callback) {
        if (typeof callback !== "function") {
            return;
        }

        db.query("SELECT * FROM `channels` WHERE owner=?", [owner],
        function (err, res) {
            if (err) {
                callback(err, []);
                return;
            }

            callback(err, res);
        });
    },

    /**
     * Loads the channel from the database
     */
    load: function (chan, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan.name)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT * FROM `channels` WHERE name=?", chan.name, function (err, res) {
            if (err) {
                callback(err, null);
                return;
            }

            if (res.length === 0) {
                callback("Channel is not registered", null);
                return;
            }

            if (chan.dead) {
                callback("Channel is dead", null);
                return;
            }

            // Note that before this line, chan.name might have a different capitalization
            // than the database has stored.  Update accordingly.
            chan.name = res[0].name;
            chan.uniqueName = chan.name.toLowerCase();
            chan.registered = true;
            chan.logger.log("[init] Loaded channel from database");
            callback(null, true);
        });
    },

    /**
     * Looks up a user's rank
     */
    getRank: function (chan, name, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT name,rank FROM `chan_" + chan + "_ranks` WHERE name=?",
                 [name],
        function (err, rows) {
            if (err) {
                callback(err, 1);
                return;
            }

            if (rows.length === 0) {
                callback(null, 1);
                return;
            }

            callback(null, rows[0].rank);
        });
    },

    /**
     * Looks up multiple users' ranks at once
     */
    getRanks: function (chan, names, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        var replace = "(" + names.map(function () { return "?"; }).join(",") + ")";
        db.query("SELECT name,rank FROM `chan_" + chan + "_ranks` WHERE name IN " +
                 replace, names,
        function (err, rows) {
            if (err) {
                callback(err, []);
                return;
            }

            callback(null, rows.map(function (r) { return r.rank; }));
        });
    },

    /**
     * Query all user ranks at once
     */
    allRanks: function (chan, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT name,rank FROM `chan_" + chan + "_ranks` WHERE 1", callback);
    },

    /**
     * Updates a user's rank
     */
    setRank: function (chan, name, rank, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (rank < 2) {
            module.exports.deleteRank(chan, name, callback);
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("INSERT INTO `chan_" + chan + "_ranks` (name, rank) VALUES (?, ?) " +
                 "ON DUPLICATE KEY UPDATE rank=?", [name, rank, rank], callback);
    },

    /**
     * Inserts a new user rank entry without clobbering an existing one
     */
    newRank: function (chan, name, rank, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("INSERT INTO `chan_" + chan + "_ranks` (name, rank) VALUES (?, ?) " +
                 "ON DUPLICATE KEY UPDATE rank=rank", [name, rank], callback);
    },

    /**
     * Removes a user's rank entry
     */
    deleteRank: function (chan, name, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("DELETE FROM `chan_" + chan + "_ranks` WHERE name=?", [name], callback);
    },

    /**
     * Adds a media item to the library
     */
    addToLibrary: function (chan, media, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("INSERT INTO `chan_" + chan + "_library` (id, title, seconds, type) " +
                 "VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE id=id",
                 [media.id, media.title, media.seconds, media.type], callback);
    },

    /**
     * Retrieves a media item from the library by id
     */
    getLibraryItem: function (chan, id, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT * FROM `chan_" + chan + "_library` WHERE id=?", [id],
        function (err, rows) {
            if (err) {
                callback(err, null);
                return;
            }

            if (rows.length === 0) {
                callback("Item not in library", null);
            } else {
                callback(null, rows[0]);
            }
        });
    },

    /**
     * Search the library by title
     */
    searchLibrary: function (chan, search, callback) {
        if (typeof callback !== "function") {
            return;
        }

        db.query("SELECT * FROM `chan_" + chan + "_library` WHERE title LIKE ?",
                 ["%" + search + "%"], callback);
    },

    /**
     * Deletes a media item from the library
     */
    deleteFromLibrary: function (chan, id, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("DELETE FROM `chan_" + chan + "_library` WHERE id=?", [id], callback);
    },

    /**
     * Add a ban to the banlist
     */
    ban: function (chan, ip, name, note, bannedby, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("INSERT INTO `chan_" + chan + "_bans` (ip, name, reason, bannedby) " +
                 "VALUES (?, ?, ?, ?)", [ip, name, note, bannedby], callback);
    },

    /**
     * Check if an IP address or range is banned
     */
    isIPBanned: function (chan, ip, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        var range = ip.replace(/^(\d+\.\d+\.\d+)\.\d+$/, "$1");

        db.query("SELECT * FROM `chan_" + chan + "_bans` WHERE ip=? OR ip=?", [ip, range],
        function (err, rows) {
            callback(err, err ? false : rows.length > 0);
        });
    },

    /**
     * Check if a username is banned
     */
    isNameBanned: function (chan, name, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT * FROM `chan_" + chan + "_bans` WHERE name=?", [name],
        function (err, rows) {
            callback(err, err ? false : rows.length > 0);
        });
    },

    /**
     * Lists all bans
     */
    listBans: function (chan, callback) {
        if (typeof callback !== "function") {
            return;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("SELECT * FROM `chan_" + chan + "_bans` WHERE 1", callback);
    },

    /**
     * Removes a ban from the banlist
     */
    unbanName: function (chan, name, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("DELETE FROM `chan_" + chan + "_bans` WHERE ip='*' AND name=?",
                 [name], callback);
    },

    /**
     * Removes a ban from the banlist
     */
    unbanIP: function (chan, ip, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("DELETE FROM `chan_" + chan + "_bans` WHERE ip=?",
                 [ip], callback);
    },

    /**
     * Removes a ban from the banlist
     */
    unbanId: function (chan, id, callback) {
        if (typeof callback !== "function") {
            callback = blackHole;
        }

        if (!valid(chan)) {
            callback("Invalid channel name", null);
            return;
        }

        db.query("DELETE FROM `chan_" + chan + "_bans` WHERE id=?",
                 [id], callback);
    }
};
