/**
 * CCC_CODE / SUPP_OFF → Division lookup for Malda Zone NSC.
 * Built from the workbook Sheet1 (CODE, REGION, DIVISION, CCC) mapping.
 */
const officeMap = require('./nsc_office_map.json');

function resolveDivnFromOffice(cccCode, suppOff) {
    const code = String(cccCode == null ? '' : cccCode).trim();
    if (code && officeMap.byCode[code]) return officeMap.byCode[code];
    const supp = String(suppOff == null ? '' : suppOff).trim();
    if (supp && officeMap.bySupp[supp]) return officeMap.bySupp[supp];
    return '';
}

module.exports = {
    officeMap,
    byCode: officeMap.byCode,
    bySupp: officeMap.bySupp,
    resolveDivnFromOffice
};
