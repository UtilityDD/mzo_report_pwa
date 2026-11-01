#!/usr/bin/env node
'use strict';
// Hash a password for a VM-only admin account (MZO_LOCAL_ADMINS in /etc/mzo/app.env).
//
//   node scripts/tools/hash-password.js                         prints scrypt$N$r$p$salt$hash
//   node scripts/tools/hash-password.js <username> "<Name>"     prints the whole entry username|Name|scrypt$…
//
// The password is read from stdin and never from the command line: typed without echo (asked twice)
// on a terminal, or piped (one line). Node's crypto only. See docs/vm.md, "VM-only admin accounts".

const { hashPassword } = require('../../lib/local_admins');

const MIN_LENGTH = 10;

/** One line from a terminal without echoing it. */
function readHidden(prompt) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        process.stderr.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let value = '';
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    process.stderr.write('\n');
                    return resolve(value);
                }
                if (ch === '\u0003') { // Ctrl-C
                    stdin.setRawMode(false);
                    process.stderr.write('\n');
                    return reject(Object.assign(new Error('cancelled'), { code: 130 }));
                }
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else if (ch >= ' ') value += ch;
            }
        };
        stdin.on('data', onData);
    });
}

/** The first line of piped stdin (its newline removed). */
function readPiped() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const [username, name] = process.argv.slice(2);
    if (process.argv.length > 4 || (username && !name)) {
        console.error('Usage: node scripts/tools/hash-password.js [<username> "<Display Name>"]   (the password comes from stdin)');
        return 2;
    }
    if (username && !/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
        console.error('The username may use letters, digits, dot, dash and underscore (2 to 64 characters).');
        return 2;
    }
    if (name && /[|;]/.test(name)) {
        console.error('The display name cannot contain | or ;.');
        return 2;
    }
    let password;
    if (process.stdin.isTTY) {
        password = await readHidden('Password: ');
        const again = await readHidden('Again: ');
        if (again !== password) {
            console.error('The two passwords differ.');
            return 1;
        }
    } else {
        password = await readPiped();
    }
    // The sign-in page trims what is typed, so a password must not start or end with spaces.
    if (password !== password.trim()) {
        console.error('The password cannot start or end with a space.');
        return 1;
    }
    if (password.length < MIN_LENGTH) {
        console.error(`Use at least ${MIN_LENGTH} characters.`);
        return 1;
    }
    const hash = hashPassword(password);
    process.stdout.write((username ? `${username}|${name.trim()}|${hash}` : hash) + '\n');
    return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err.code === 130 ? 'Cancelled.' : err.message);
    process.exitCode = err.code === 130 ? 130 : 1;
});
