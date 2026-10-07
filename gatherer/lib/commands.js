// Every command word the bots understand.
//
// "<botname> <command>" addresses one crew member. A bot can be named after a
// command (a bot called "Guard"), so a name only counts as an address when a
// command follows it: ".guard" and ".guard Zentyre" are the guard command,
// ".Guard status" asks the bot named Guard.

const COMMANDS = new Set([
    "get", "gather", "craft", "smelt", "plan", "farm", "plant", "breed", "brew", "sleep", "water", "bucket",
    "learned", "memory", "forget", "guard", "bodyguard", "protect", "bow", "armor", "give", "drop", "stop",
    "say", "status", "queue", "inv", "eat", "come", "deposit", "home", "quit", "help", "crew",
]);

// Is `word` (a bot's name, followed by `rest`) meant as an address?
function addresses(word, rest) {
    if (!COMMANDS.has(String(word).toLowerCase())) return true;
    return rest.length > 0 && COMMANDS.has(String(rest[0]).toLowerCase());
}

module.exports = { COMMANDS, addresses };
