const fs = require('fs');
const text = fs.readFileSync('solar.csv', 'utf8');
const lines = text.split(/\r?\n/);

// Handling comma inside quotes naive logic or just use headers
// Let's use PapaParse if available since the dashboard uses it.
let headers = [];
let remarks = new Set();
let statusSet = new Set();

// Simple CSV line parser
function parseLine(line) {
    let result = [];
    let startValueBfr = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        if (inQuotes) {
            if (line[i] === '"') {
                if (line[i + 1] === '"') {
                    startValueBfr += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                startValueBfr += line[i];
            }
        } else {
            if (line[i] === '"') {
                inQuotes = true;
            } else if (line[i] === ',') {
                result.push(startValueBfr);
                startValueBfr = '';
            } else {
                startValueBfr += line[i];
            }
        }
    }
    result.push(startValueBfr);
    return result;
}

if (lines.length > 0) {
    headers = parseLine(lines[0]);
    const remarksIndex = headers.indexOf('REMARKS');
    const statusIndex = headers.indexOf('REPLACE_STATUS');

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = parseLine(lines[i]);
        if (cols.length > remarksIndex && remarksIndex !== -1) remarks.add(cols[remarksIndex]);
        if (cols.length > statusIndex && statusIndex !== -1) statusSet.add(cols[statusIndex]);
    }
}

fs.writeFileSync('out.txt', JSON.stringify({ headers, remarks: [...remarks], status: [...statusSet] }, null, 2));
