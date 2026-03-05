const fs = require('fs');

function parseCSVLine(line) {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(cur.trim());
            cur = '';
        } else {
            cur += char;
        }
    }
    result.push(cur.trim());
    return result;
}

const content = fs.readFileSync('load_ext.csv', 'utf8');
const lines = content.split('\n');
const header = parseCSVLine(lines[0]);
console.log('Header:', header);

const collectionStatusIdx = header.indexOf('COLLECTION_STATUS');
const servConnStatusIdx = header.indexOf('SERV_CONN_STATUS');

const collectionStatuses = {};
const servConnStatuses = {};
let nonWorkingCount = 0;

for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < header.length) continue;

    const cs = row[collectionStatusIdx];
    const scs = row[servConnStatusIdx];

    collectionStatuses[cs] = (collectionStatuses[cs] || 0) + 1;
    servConnStatuses[scs] = (servConnStatuses[scs] || 0) + 1;

    if (scs !== 'Working') {
        nonWorkingCount++;
        if (nonWorkingCount < 10) {
            console.log('Non-Working Row Sample:', row[servConnStatusIdx], row[header.indexOf('CON_ID')]);
        }
    }
}

console.log('Total Rows (excluding header):', lines.length - 1);
console.log('Collection Statuses:', collectionStatuses);
console.log('Serv Conn Statuses:', servConnStatuses);
