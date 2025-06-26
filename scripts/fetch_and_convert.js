const fs = require('fs');
const fetch = require('node-fetch');
const Papa = require('papaparse');

const sources = {
  "Balurghat": "https://docs.google.com/spreadsheets/d/e/2PACX-1vRooKVx76f92WX_Q3j2u4UmA1yXN2cNcwSPVqiFjyY58oTplAg_Ieze4xket4Lq3qHEuLt9js0-kU8a/pub?gid=98784562&single=true&output=csv",
  "Malda": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQHtBkI-9-cafLDNyCNtbnHX0B65dCawQHoO8oiFYQzeWBxu0u4VBXCqR5zgj5ylceF3piSl8rnholp/pub?gid=98784562&single=true&output=csv",
  "Raiganj": "https://docs.google.com/spreadsheets/d/e/2PACX-1vR-jd3bm9BCgUKNQCgr0Lj9paLYQ9oacLPlleCHXrtV1__58NyK_w19hbC4thzgPkdHtIAAP2nrnmyC/pub?gid=98784562&single=true&output=csv",
  "Buniadpur": "https://docs.google.com/spreadsheets/d/e/2PACX-1vTZPn6CB_cHTFVb8S5vpvaBnczj63fYMTI0RVEdMzVcQ8O6XQi5iwTbMp2xa5vsL6zHGWxezWUSehrN/pub?gid=98784562&single=true&output=csv",
  "Gazole": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQeQ8Rj3WDvBw5FEYP2rYbRV7p0HvnxuXfBlfpTtJY_K-rnYCNoMsFM426rrGsK5tYMLmhK2LnJ1HP-/pub?gid=98784562&single=true&output=csv",
  "Islampur": "https://docs.google.com/spreadsheets/d/e/2PACX-1vTsXWZdt0B4LpbxbstdJv564CnjEBMCC_HwlssthZCXLTKpUFkF_dhQtEpN0KYD-eKiClTwA2WOhSB-/pub?gid=98784562&single=true&output=csv",
  "Chanchal": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6XAKcdyjGWhdxB7FPTwzlEUN5fgLXFuLE_8VSSsiGvbfcY4uLPY8zzlnMmqAqEeF7J6FQqW26R-jr/pub?gid=98784562&single=true&output=csv"
};

const parseDate = (str) => {
  const [d, m, y] = str.split(/[/-]/).map(Number);
  return new Date(y, m - 1, d).toISOString();
};

(async () => {
  try {
    fs.mkdirSync('data', { recursive: true });

    for (const [division, url] of Object.entries(sources)) {
      const res = await fetch(url);
      const csv = await res.text();

      const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });

      const out = data
        .filter(row => row['Issued Date'] && row['Net Balance Value'])
        .map(row => ({
          date: parseDate(row['Issued Date']),
          unit: row['Unit'] || '',
          vendor: row['VendorName'] || '',
          material: row['Material description'] || '',
          value: parseFloat(String(row['Net Balance Value']).replace(/[₹,]/g, '')) || 0
        }));

      fs.writeFileSync(`data/adv_${division}.json`, JSON.stringify(out, null, 2));
      console.log(`✅ Saved: data/adv_${division}.json`);
    }

    console.log("✅ All JSONs written.");
  } catch (err) {
    console.error("❌ Script error:", err);
    process.exit(1);
  }
})();
