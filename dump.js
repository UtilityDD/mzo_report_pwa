const fs = require('fs');
const text = fs.readFileSync('solar.csv', 'utf8');
const lines = text.split(/\r?\n/);
const headers = lines[0].split(',');
console.log(JSON.stringify(headers));

const remarksIndex = headers.indexOf('REMARKS');
const statusIndex = headers.indexOf('REPLACE_STATUS');

let remarks = new Set();
let statusSet = new Set();

for (let i = 1; i < lines.length; i++) {
    // Basic CSV split, might break on quotes, but fine for simple inspection
    const cols = lines[i].split(',');
    if (cols.length > remarksIndex && remarksIndex !== -1) {
        remarks.add(cols[remarksIndex]);
    }
    if (cols.length > statusIndex && statusIndex !== -1) {
        statusSet.add(cols[statusIndex]);
    }
}

console.log('REMARKS:', [...remarks]);
console.log('REPLACE_STATUS:', [...statusSet]);
