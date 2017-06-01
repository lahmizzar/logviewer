var fs = require("fs");
var events = require('events');
var winston = require('winston');

var ircbot = require('./ircbot');
var pubsub = require('./pubsub');
var messagecompressor = require('./messagecompressor');
var TAGS = 1
var PREFIX = 2
var COMMAND = 3
var PARAM = 4
var TRAILING = 5
var TWITCHNOTIFYID = 46325627;
var JTVID = 14027;
function logviewerBot(settings, db, io) {
	var self = this;
	self.settings = settings;
	self.nick = settings.bot.nick;
	self.API = null;
	self.db = db;
	self.io = io;
	
	self.pubsub = new pubsub(settings, db, io);
	
	var messagecompressor = require('./messagecompressor');
	
	var host = "irc.chat.twitch.tv";
	var port = 6667;
	var hostandport = /([^:^\/]+)(?:[:/](\d+))?/.exec(settings.bot.server);
	if(hostandport) {
		if(hostandport[1]) {
			host = hostandport[1];
		}
		if(hostandport[2]) {
			port = parseInt(hostandport[2]);
		}
	}
	self.bot = new ircbot(host, port);
	self.userlevels = {}; // temporary user levels (mod etc)
	self.channels = [];
	self.id2channelObj = {};
	self.name2channelObj = {};
	
	
	self.bot.on("connect", function(){
		self.bot.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
		var oauth = settings.bot.oauth;
		if(!oauth.startsWith("oauth:")) oauth = "oauth:"+oauth;
		self.bot.send("PASS "+oauth);
		self.bot.send("NICK "+settings.bot.nick);
		db.getChannels(function(channels){
			for(var i=0;i<channels.length;++i) {
				self.joinChannel(channels[i]);
				if(channels[i].modlogs == "1") {
					winston.debug("Channel "+channels[i].name+" has mod logs enabled");
					self.enableModLogs(channels[i]);
				}
			}
		});
		winston.info("Connected!");
	});

	self.bot.on("raw", function(data){
		if(data[COMMAND] != "PRIVMSG") {
			winston.debug(data[0]);
		}
	});

	var newsubregex = new RegExp("(\\w+) just subscribed( with Twitch Prime)?!");
	var resubregex = new RegExp("(\\w+) subscribed for (\\d+) months in a row!");
	self.bot.on("PRIVMSG", function(data){
		var user = /\w+/.exec(data[PREFIX])[0];
		var channel = data[PARAM].slice(1);
		var text = data[TRAILING];
		winston.debug("#" + channel + " <" + user +"> " + text);
		
		// if the user is a mod, set his level to 5
		if(data[TAGS] && data[TAGS]["mod"] === "1" && self.userlevels[channel]) {
			self.userlevels[channel][user] = 5;
		}
		
		// remove the user from the recent timeouts (unless they were VERY recent (<2s ago)
		var oldtimeout = (self.timeouts[channel] && self.timeouts[channel][user]) || (self.oldtimeouts[channel] && self.oldtimeouts[channel][user]);
		if(oldtimeout) {
			var age = Date.now()/1000 - oldtimeout.time;
			if(age >= 2) {
				if(self.timeouts[channel] && self.timeouts[channel][user]) self.timeouts[channel][user] = undefined;
				if(self.oldtimeouts[channel] && self.oldtimeouts[channel][user]) self.oldtimeouts[channel][user] = undefined;
			}
		}
		
		if(self.timeouts[channel] && self.timeouts[channel][user]) {
			var now = 
			self.timeouts[channel][user] = undefined;
		}
		if(self.oldtimeouts[channel] && self.oldtimeouts[channel][user]) self.oldtimeouts[channel][user] = undefined;
		
		
		var time = Math.floor(Date.now()/1000);
		
		setTimeout(()=>{				
			var modlog;
			if(data[TAGS] && data[TAGS]["id"]) {
				var allowedMessage = allowedMessages[data[TAGS]["id"]] || oldAllowedMessages[data[TAGS]["id"]];
				if(allowedMessage) {
					modlog = allowedMessage.modlog;
				}
			}
			db.addLine(channel, user, data[TAGS]["user-id"], Date.now(), messagecompressor.compressMessage(user, data), modlog, function(id) {
				var emittedMsg = {id: id, time: time, nick: user, text: data[0]};
				io.to("logs-"+channel+"-"+user).emit("log-add", emittedMsg);
				emittedMsg.modlog = modlog;
				io.to("logs-"+channel+"-"+user+"-modlogs").emit("log-add", emittedMsg);
			});
			db.updateStats(channel, user, {messages: 1});
		}, 10);
	});

	self.bot.on("USERNOTICE", function(data){
		if(data[TAGS] && data[TAGS]["msg-id"]=="resub" || data[TAGS]["msg-id"]=="sub") {
			var time = Math.floor(Date.now()/1000);
			var channel = data[PARAM].slice(1);
			var text = data[TAGS]["system-msg"].replace(/\\s/g," ");
			if(data[TRAILING]) text += " Message: "+data[TRAILING];
			var sub = data[TAGS]["login"];
			db.addLine(channel, "twitchnotify", TWITCHNOTIFYID, Date.now(), "dtwitchnotify "+text, null, function(id) {
				var irccmd = `@display-name=twitchnotify;color=;subscriber=0;turbo=0;user-type=;emotes=;mod=0 :${sub}!${sub}@${sub}.tmi.twitch.tv PRIVMSG #${channel} :${text}`;
				io.to("logs-"+channel+"-twitchnotify").emit("log-add", {id: id, time: time, nick: "twitchnotify", text: irccmd});
				io.to("logs-"+channel+"-twitchnotify-modlogs").emit("log-add", {id: id, time: time, nick: "twitchnotify", text: irccmd});
			});
			db.updateStats(channel, "twitchnotify", {messages: 1});
			db.addLine(channel, sub, data[TAGS]["user-id"], Date.now(), "dtwitchnotify "+text, null, function(id) {
				var irccmd = `@display-name=twitchnotify;color=;subscriber=0;turbo=0;user-type=;emotes=;mod=0 :${sub}!${sub}@${sub}.tmi.twitch.tv PRIVMSG #${channel} :${text}`;
				io.to("logs-"+channel+"-"+sub).emit("log-add", {id: id, time: time, nick: sub, text: irccmd});
				io.to("logs-"+channel+"-"+sub+"-modlogs").emit("log-add", {id: id, time: time, nick: sub, text: irccmd});
			});
		}
	});

	// Everything having to do with timeouts/bans
	var ROTATECYCLE = 30000;
	var MAXDIFF = 5000;

	self.timeouts = {};
	self.oldtimeouts = {};

	function rotateTimeouts(){
		self.oldtimeouts = self.timeouts;
		self.timeouts = {};
	}
	setInterval(rotateTimeouts, ROTATECYCLE);

	var formatTimespan = function(timespan) {
		var age = Math.round(timespan);
		var periods = [
			{abbr:"y", len: 3600*24*365},
			{abbr:"m", len: 3600*24*30},
			{abbr:"d", len: 3600*24},
			{abbr:" hrs", len: 3600},
			{abbr:" min", len: 60},
			{abbr:" sec", len: 1},
		];
		var res = "";
		var count = 0;
		for(var i=0;i<periods.length;++i) {
			if(age >= periods[i].len) {
				var pval = Math.floor(age / periods[i].len);
				age = age % periods[i].len;
				res += (res?" ":"")+pval+periods[i].abbr;
				count ++;
				if(count >= 2) break;
			}
		}
		return res;
	}

	function formatCount(i) {
		return i<=1?"":" ("+i+" times)"; 
	}

	function formatTimeout(user, timeout) {
		if(isFinite(timeout.duration)){
			// timeout
			if(timeout.reasons.length==0)
				return "<"+user+" has been timed out for "+formatTimespan(timeout.duration)+formatCount(timeout.count)+">"
			else if(timeout.reasons.length==1)
				return "<"+user+" has been timed out for "+formatTimespan(timeout.duration)+". Reason: "+timeout.reasons.join(", ")+formatCount(timeout.count)+">"
			else
				return "<"+user+" has been timed out for "+formatTimespan(timeout.duration)+". Reasons: "+timeout.reasons.join(", ")+formatCount(timeout.count)+">"
		} else {
			// banned
			if(timeout.reasons.length==0)
				return "<"+user+" has been banned>"
			else if(timeout.reasons.length==1)
				return "<"+user+" has been banned. Reason: "+timeout.reasons.join(", ")+">"
			else
				return "<"+user+" has been banned. Reasons: "+timeout.reasons.join(", ")+">"
		}
	}

	function emitTimeout(type, channelObj, user, timeout) {
		var irccmd = `@display-name=jtv;color=;subscriber=0;turbo=0;user-type=;emotes=;badges= :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${channelObj.name} :${timeout.text}`
		var time = Math.floor(timeout.time.getTime()/1000);
		io.to("logs-"+channelObj.id+"-"+user).emit(type, {id: timeout.id, time: time, nick: user, text: irccmd});
		io.to("logs-"+channelObj.id+"-"+user+"-modlogs").emit(type, {id: timeout.id, time: time, nick: user, modlog: timeout.modlog, text: irccmd});
	}
	
	function doTimeout(channelObj, mod, modid, user, userid, duration, reason, inc) {
		// search for the user in the recent timeouts
		var oldtimeout = (self.timeouts[channelObj.id] && self.timeouts[channelObj.id][userid]) || (self.oldtimeouts[channelObj.id] && self.oldtimeouts[channelObj.id][user]);
		var now = new Date();
		if(self.timeouts[channelObj.id] === undefined) self.timeouts[channelObj.id] = {};
		duration = parseInt(duration) || Infinity;
		
		if(oldtimeout) {
			// if a reason is specified and its new, we add it
			if(reason && oldtimeout.reasons.indexOf(reason)<0) {
				oldtimeout.reasons.push(reason);
			}
			
			if(mod) oldtimeout.modlog[mod] = duration;
			if(isFinite(oldtimeout.duration) && !isFinite(duration)) {
				// a user that was timed out got banned now.
				db.updateStats(channelObj, user, {timeouts: -1, bans: 1});
			}
			
			
			var oldends = oldtimeout.time.getTime()+oldtimeout.duration*1000;
			var newends = now.getTime()+duration*1000;
			// only completely update significant changes in the end of the timeout
			if(Math.abs(oldends-newends) > MAXDIFF) {
				oldtimeout.time = now;
				oldtimeout.duration = duration;
			}
			
			oldtimeout.count += inc;
			oldtimeout.text = formatTimeout(user, oldtimeout);
			// put it into the primary rotation again
			self.timeouts[channelObj.id][user] = oldtimeout;
			
			// update the database
			if(oldtimeout.id) {
				db.updateTimeout(channelObj, user, oldtimeout.id, now.getTime(), "djtv "+oldtimeout.text, oldtimeout.modlog);
				// emit timeout via websockets
				emitTimeout("log-update", channelObj, user, oldtimeout);
			}
			else oldtimeout.dirty = true;
			
		} else {
			var modlog = {};
			if(mod) modlog[mod] = duration;
			var timeout = {time: now, duration: duration, reasons: reason?[reason]:[], count: inc, modlog: modlog};
			
			timeout.text = formatTimeout(user, timeout);
			// add the timeout to the cache with an empty id
			self.timeouts[channelObj.id][user] = timeout;
			db.addTimeout(channelObj, user, now.getTime(), "djtv "+timeout.text, modlog, function(id){
				timeout.id = id;
				// if the timeout was dirty, update it again...
				if(timeout.dirty) {
					db.updateTimeout(channelObj, user, id, timeout.time.getTime(), "djtv "+timeout.text, timeout.modlog);
				}
				// emit timeout via websockets
				emitTimeout("log-add", channelObj, user, timeout);
			});
			if(isFinite(duration)) db.updateStats(channelObj, user, {timeouts:1});
			else db.updateStats(channelObj, user, {bans:1});
		}
	}
	
	function doUnban(channelObj, mod, modid, type, user, userid) {
		var modlog = {};
		modlog[mod] = -1;
		var text = `<${user} has been ${type}>`;
		db.addLine(channelObj, user, userid, Date.now(), "djtv "+text, modlog, null, function(id){
			var irccmd = `@display-name=jtv;color=;subscriber=0;turbo=0;user-type=;emotes=;badges= :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${channelObj.name} :${text}`;
			io.to("logs-"+channelObj.id+"-"+userid).emit("log-add", {id: id, time: Math.floor(Date.now()/1000), nick: user, text: irccmd});
			io.to("logs-"+channelObj.id+"-"+userid+"-modlogs").emit("log-add", {id: id, time: Math.floor(Date.now()/1000), nick: user, modlog: modlog, text: irccmd});
		});
	}
	
	function emitRejectedMessage(type, channelObj, command) {
		var user = command.args[0];
		var message = command.args[1];
		var irccmd = `@display-name=twitchbot;color=;subscriber=0;turbo=0;user-type=;emotes=;badges= :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${channelObj.name} :${message}`

		var emittedMsg = {id: command.id, time: Math.floor(command.time/1000), nick: user, text: irccmd};
		io.to("logs-"+channelObj.id+"-"+user).emit(type, emittedMsg);
		emittedMsg.modlog = command.modlog;
		console.log("Emitting "+JSON.stringify(emittedMsg));
		console.log("to logs-"+channelObj.id+"-"+user+"-modlogs")
		io.to("logs-"+channelObj.id+"-"+user+"-modlogs").emit(type, emittedMsg);
	}
	
	var rejectedMessages = {};
	var oldRejectedMessages = {};
	var allowedMessages = {};
	var oldAllowedMessages = {};
	function doReject(channelObj, user, command) {
		command.time = Date.now();
		command.modlog = {};
		command.modlog[user] = "reject";
		db.addTimeout(channelObj, command.args[0], command.time, "dtwitchbot " + command.args[1], command.modlog, function(id){
			command.id = id;
			emitRejectedMessage("log-add", channelObj, command);
			if(command.dirty) {
				db.updateTimeout(channelObj, command.args[0], command.id, command.time, "dtwitchbot " + command.args[1] , command.modlog);
			}
		});
		rejectedMessages[command.msg_id] = command;
	}
	
	function doModerate(channelObj, user, command) {
		var action = command.moderation_action.split("_")[0];
		var oldModlog = rejectedMessages[command.msg_id] || oldRejectedMessages[command.msg_id];
		if(oldModlog) {
			oldModlog.modlog[user] = action;
			if(oldModlog.id) {
				db.updateTimeout(channelObj, oldModlog.args[0], oldModlog.id, oldModlog.time, "dtwitchbot " + oldModlog.args[1], oldModlog.modlog);
				emitRejectedMessage("log-update", channelObj, oldModlog);
			} else {
				oldModlog.dirty = true;
			}
		} else {
			command.time = Date.now();
			command.modlog = {};
			command.modlog[user] = action;
			allowedMessages[command.msg_id] = command;
		}
	}
	
	setInterval(function() {
		oldRejectedMessages = rejectedMessages;
		oldAllowedMessages = allowedMessages;
		rejectedMessages = {};
		allowedMessages = {};
	}, 300000);


	self.bot.on("CLEARCHAT", function(data){
		let user = data[TRAILING];
		let userid = data[TAGS]["target-user-id"];
		let channelObj = {name: data[PARAM].slice(1), id: data[TAGS]["room-id"];
		if(user && user.length > 0) {
			let duration,reason;
			if(data[TAGS]) {
				if(data[TAGS]["ban-duration"]) duration = data[TAGS]["ban-duration"];
				if(data[TAGS]["ban-reason"]) reason = data[TAGS]["ban-reason"].replace(/\\s/g," ");
			}
			doTimeout(channelObj, undefined, user, duration, reason, 1);
		} else {
			winston.debug("#" + channelObj.name + " <chat was cleared by a moderator>");
			db.addTimeout(channelObj, "jtv", Date.now(), "djtv <chat was cleared by a moderator>");
		}
	});

	var lastSave = Date.now();
	self.bot.on("NOTICE", function(data){
		//:tmi.twitch.tv NOTICE #ox33 :The moderators of this room are: 0x33, andyroid, anoetictv
		//@msg-id=msg_banned :tmi.twitch.tv NOTICE #frankerzbenni :You are permanently banned from talking in frankerzbenni.
		let channel = data[PARAM].slice(1);
		if(data[TAGS] && (data[TAGS]["msg-id"] === "room_mods" || data[TAGS]["msg-id"] === "no_mods")) {
			let users = [];
			if(data[TAGS]["msg-id"] === "room_mods") {
				let m = /The moderators of this \w+ are: (.*)/.exec(data[TRAILING]);
				users = m[1].match(/\w+/g);
			}
			
			
			// check if the moderation status of the bot has changed
			var ismodded = users.indexOf(self.nick) >= 0;
			if(self.userlevels[channel] && ismodded * 5 != (self.userlevels[channel][self.nick] || 0)) {
				// emit the moderation status changed event via ws
				self.io.to("events-"+channel).emit("ismodded", ismodded);
				
				if(!ismodded) {
					let channelObj = self.findChannelObj({name: channel});
					// disable mod log setting
					winston.info("Got unmodded in "+channel+" - "+JSON.stringify(channelObj)+" unlistening from mod logs");
					self.disableModLogs(channelObj);
					self.db.setSetting(channel, "modlogs", "0");
					self.API.adminLog(channel, "", "system", "modlogs-disabled", "Detected that the bot is no longer modded in your channel. Disabled mod logs.");
				}
			}
			
			let userlist = {};
			for(let i=0;i<users.length;++i) {
				userlist[users[i]] = 5;
			}
			
				
			self.userlevels[channel] = userlist;
			self.emit("moderator-list-"+channel, users);
			
			
			if(Date.now() - lastSave > 60*1000) {
				// write to file every minute
				lastSave = Date.now();
				fs.writeFile("mods.json", JSON.stringify(self.userlevels), "utf-8");
			}
		} else if(data[TAGS] && data[TAGS]["msg-id"] === "msg_banned"){
			// we were banned from the channel, leave it.
			let channelObj = self.findChannelObj({name: channel});
			self.emit("moderator-list-"+channel, []); // emit an empty mod list in case we were waiting for those);
			db.setSetting(channel, "active", "0");
			self.partChannel(channelObj);
			if(self.API) {
				self.API.adminLog(channel, "", "system", "banned", "Detected that the bot is banned from the channel. Disabled the logviewer.");
			}
		} else {
			db.addLine(channel, "jtv", 0, Date.now(), "djtv "+data[TRAILING], null);
		}
	});
	var regexes_channel_user =
		[
			/^#(\w+)\s+(\w+)$/,
			/^(\w+)\s+(\w+)$/,
			/^logof (\w+)\s+(\w+)$/,
			/^!logs? (\w+)\s+(\w+)$/,
		];
	var regexes_user_channel =
		[
			/^(\w+)\s+#(\w+)$/,
			/^(\w+)\s+(\w+)/,
			/^(\w+) in (\w+)$/,
			/^logof (\w+)\s+(\w+)$/,
			/^!logs? (\w+)\s+(\w+)$/,
		];
		
	var getLogs = function(channel, nick, requestedby, callback) {
		db.getActiveChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				callback(undefined, nick);
			}
			if(channelObj.viewlogs > 0) {
				db.getUserLevel(channelObj.name, requestedby, function(level){
					if(level >= channelObj.viewlogs) {
						db.getLogsByNick(channelObj.name, nick, 2, false, function(messages){
							for(var i=0;i<messages.length;++i) {
								messages[i].text = messagecompressor.decompressMessage("#"+channelObj.name, messages[i].nick, messages[i].text);
							}
							callback(messages, nick);
						});
					} else {
						callback(undefined, nick);
					}
				});
			} else {
				db.getLogsByNick(channelObj.name, nick, 2, false, function(messages){
					for(var i=0;i<messages.length;++i) {
						messages[i].text = messagecompressor.decompressMessage("#"+channelObj.name, messages[i].nick, messages[i].text);
					}
					callback(messages, nick);
				});
			}
		});
	}

	fs.readFile("mods.json", "utf-8", function(err, data) {
		if(err) {
			winston.info("No mods.json found.")
		} else {
			self.userlevels = JSON.parse(data);
		}
	});

	var currentchannel = 0;
	var checkNextMods = function() {
		if(self.channels.length > 0) {
			self.checkMods(self.channels[currentchannel%(self.channels.length)]);
			currentchannel++;
		}
	}
	setInterval(checkNextMods,(settings.bot.modcheckinterval || 2) * 1000);

	self.bot.connect();
	
	// react to mod logs, if present
	self.pubsub.on("MESSAGE", function(message, flags) {
		winston.debug("Handling pubsub message "+JSON.stringify(message));
		let topic = message.data.topic.split(".");
		if(topic[0] == "chat_moderator_actions") {
			var channelid = topic[2];
			var channelObj = self.findChannelObj({id: channelid});
			var channel = channelObj.name;
			var command = JSON.parse(message.data.message).data;
			winston.debug(command);
			var user = command.created_by;
			if(command.moderation_action == "timeout") {
				doTimeout(channel, user, command.args[0].toLowerCase(), command.args[1] || 600, command.args[2] || "", 0);
			} else if(command.moderation_action == "ban") {
				doTimeout(channel, user, command.args[0].toLowerCase(), Infinity, command.args[1] || "", 0);
			} else if(command.moderation_action == "unban") {
				doUnban(channel, user, "unbanned", command.args[0].toLowerCase());
			} else if(command.moderation_action == "untimeout") {
				doUnban(channel, user, "untimed out", command.args[0].toLowerCase());
			} else if(command.moderation_action == "automod_rejected") {
				doReject(channel, user, command);
			} else if(command.moderation_action == "denied_automod_message" || command.moderation_action == "allowed_automod_message") {
				doModerate(channel, user, command);
			} else {
				var text = "/"+command.moderation_action;
				if(command.args) text += " "+command.args.join(" ");
				var modlog = {};
				modlog[user] = "";
				db.addLine(channel, "jtv", 0, Date.now(), "djtv "+text, modlog, null, function(id) {
					var time = Math.floor(Date.now()/1000);
					io.to("logs-"+channel+"-"+user).emit("log-add", {id: id, time: time, nick: "jtv", text: `@display-name=jtv;color=;subscriber=0;turbo=0;user-type=;emotes=;badges= :jtv!jtv@jtv.tmi.twitch.tv PRIVMSG #${channel} :${text}`});
					io.to("logs-"+channel+"-"+user+"-modlogs").emit("log-add", {id: id, time: time, nick: user, modlog: modlog, text: `@display-name=jtv;color=;subscriber=0;turbo=0;user-type=;emotes=;badges= :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${channel} :${text}`});
				});
				self.API.adminLog(channel, user, "command", command.moderation_action, text);
			}
		}
	});
}

logviewerBot.prototype = new events.EventEmitter;
	
logviewerBot.prototype.findChannelObj = function(channel) {
	var self = this;
	var channelObj = self.id2channelObj[channel.id];
	if(channelObj) return channelObj;
	channelObj = self.name2channelObj[channel.name];
	if(channelObj) return channelObj;
	if(self.channels.indexOf(channel) >= 0) return channel;
	else return null;
}
	
logviewerBot.prototype.joinChannel = function(channelObj) {
	winston.info("Joining channel "+JSON.stringify(channelObj));
	var self = this;
	if(self.findChannelObj(channelObj)) return;
	self.channels.push(channelObj);
	self.bot.send("JOIN #"+channelObj.name);
	self.bot.send("PRIVMSG #"+channelObj.name+" :.mods");
	self.db.ensureTablesExist(channelObj.name);
	self.id2channelObj[channelObj.id] = channelObj;
	self.name2channelObj[channelObj.name] = channelObj;
}

logviewerBot.prototype.partChannel = function(channelObj) {
	var self = this;
	channelObj = self.findChannelObj(channelObj);
	let index = self.channels.indexOf(channelObj);
	winston.info("Leaving channel "+JSON.stringify(channelObj));
	if(index >= 0) {
		self.channels.splice(index,1)[0];
		self.bot.send("PART #"+channelObj.name);
		delete self.id2channelObj[channelObj.id];
		delete self.name2channelObj[channelObj.name];
	} else {
		self.bot.send("PART #"+channelObj.name);
		winston.error("Tried to leave channel "+channelObj.name+" that wasnt joined");
	}
}

logviewerBot.prototype.checkMods = function(channelObj) {
	var self = this;
	self.bot.send("PRIVMSG #"+channelObj.name+" :/mods");
}

// checks if the logviewer bot is modded in a channel
logviewerBot.prototype.isModded = function(channelObj, callback, force, cacheonly) {
	if(!channelObj) {
		callback(false);
		return;
	}
	var self = this;
	var channel = channelObj.name;
	if(self.userlevels[channel] && !force) {
		winston.debug("Used cached mod list for channel "+channel+": "+JSON.stringify(self.userlevels[channel]));
		callback(self.userlevels[channel][self.nick] == 5);
	} else if(!cacheonly) {
		winston.debug("Waiting for mod list for channel "+channel);
		if(force) self.checkMods(channelObj);
		self.once("moderator-list-"+channel, function(list){
			if(list.indexOf(self.nick) >= 0) {
				callback(true);
			} else {
				callback(false);
			}
		});
		self.checkMods(channelObj);
	} else {
		callback(false);
	}
	
}

logviewerBot.prototype.enableModLogs = function(channelObj, callback) {
	var self = this;
	
	self.isModded(channelObj, function(isModded) {
		if(isModded) {
			// we gucci, subscribe to pubsub
			winston.debug("Enabling mod logs for "+JSON.stringify(channelObj));
			self.pubsub.listenModLogs(channelObj);
			channelObj.modlogs = "1";
			if(callback) callback(true);
		} else {
			winston.debug("Bot is not modded in "+channelObj.name);
			if(callback) callback(false);
		}
	});
}

logviewerBot.prototype.disableModLogs = function(channelObj) {
	var self = this;
	//channelObj = self.findChannelObj(channelObj);
	self.pubsub.unlistenModLogs(channelObj);
	channelObj.modlogs = "0";
}

module.exports = logviewerBot;
