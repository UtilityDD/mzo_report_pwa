'use strict';
// Node side of the canonical office list. The list and the resolver live in lib/offices.js (shared
// with the browser as window.MzoOffices); this file adds what only the sync needs: the repo's
// data/costcenter.json (old SAP cost centres → today's offices).

const fs = require('fs');
const path = require('path');
const offices = require('../../../lib/offices.js');

try {
    const file = path.join(__dirname, '..', '..', '..', 'data', 'costcenter.json');
    offices.addCostCentres(JSON.parse(fs.readFileSync(file, 'utf8')));
} catch (_) { /* no costcenter.json next to the sync: old cost centres stay unmapped */ }

module.exports = offices;
