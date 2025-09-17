// Global variables
let allData = [];
let filteredData = [];
let currentLevel = 'region';
let selectedRegion = '';
let selectedDivision = '';
let selectedCCC = '';
let selectedCCCName = ''; // Added to store the readable CCC name
let selectedDelayRange = 'all';
let delayRanges = []; // This will be dynamically populated
let groupedModalDataMap = {}; // Holds the grouped consumer arrays

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeDates();
    loadData();
    setupEventListeners();
});

// Initialize dates
function initializeDates() {
    const today = new Date();
    const currentDate = today.toLocaleDateString('en-GB');
}

function updateMaxTodayDate(data) {
    const validDates = data.filter(d => d.TODAY).map(d => {
        const parts = d.TODAY.split('/');
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    });

    if (validDates.length > 0) {
        const maxDate = new Date(Math.max(...validDates));
        const formatted = maxDate.toLocaleDateString('en-GB');
        document.getElementById('todayDateSubtitle').textContent = formatted; // Changed ID
    } else {
        document.getElementById('todayDateSubtitle').textContent = 'No data'; // Changed ID
    }
}

// Load data from nsc.json or use embedded data
async function loadData() {
    try {
        const response = await fetch('../data/nsc.json');
        if (response.ok) {
            allData = await response.json();
            processData();
            return;
        }
    } catch (error) {
        console.log('Could not load external nsc.json file, using embedded data');
    }

    console.warn("No external data found and no fallback data defined.");
    allData = []; // Avoid crash
}


// Process data after loading
function processData() {
    // Process data to add delay calculations
    allData = allData.map(item => {
        // Ensure delay fields are treated as numbers, default to 0 if not present
        const delayInWO = parseInt(item.DelayInWO) || 0;
        const delayInSC = parseInt(item.DelayInSC) || 0;
        const delayInQtn = parseInt(item.DelayInQtn) || 0;

        const totalDelay = delayInWO + delayInSC + delayInQtn;
        return {
            ...item,
            TotalDelay: totalDelay
        };
    });

    filteredData = [...allData];
    updateMaxTodayDate(allData); // Update "Updated up to" date based on loaded data
    generateAverageDelayCards(); // Call the new function here
    initializeFilters();
    showRegionCards();
    generateKpiSummaryTables(); // ← Add this call just after `generateAverageDelayCards();`

}

// Generate dynamic delay ranges based on max delay in data
function generateDynamicDelayRanges(maxTotalDelay) {
    const ranges = new Set();
    // Fixed initial points in days
    [0, 3, 7, 10, 15, 30].forEach(d => ranges.add(d));

    // Monthly/yearly approximations
    ranges.add(60);  // 2 months
    ranges.add(90);  // 3 months
    ranges.add(150); // 5 months (approx)
    ranges.add(180); // 6 months
    ranges.add(365); // 1 year
    ranges.add(545); // 1 year 6 months (365 + 180)
    ranges.add(730); // 2 years
    ranges.add(910); // 2 years 6 months (730 + 180)

    // Add steps beyond 2 years 6 months up to maxTotalDelay
    let currentDay = 910;
    const step = 90; // Every 3 months approx
    while (currentDay < maxTotalDelay) {
        currentDay += step;
        ranges.add(currentDay);
    }
    // Ensure the maxTotalDelay itself is covered if it falls outside steps
    if (maxTotalDelay > 0 && !ranges.has(maxTotalDelay)) {
        ranges.add(maxTotalDelay);
    }

    const sortedDays = Array.from(ranges).sort((a, b) => a - b);

    const generatedRanges = sortedDays.map(days => {
        let label;
        if (days === 0) label = '0 Days';
        else if (days === 3) label = '3 Days';
        else if (days === 7) label = '7 Days';
        else if (days === 10) label = '10 Days';
        else if (days === 15) label = '15 Days';
        else if (days === 30) label = '30 Days';
        else if (days === 60) label = '2 Months';
        else if (days === 90) label = '3 Months';
        else if (days === 150) label = '5 Months';
        else if (days === 180) label = '6 Months';
        else if (days === 365) label = '1 Year';
        else if (days === 545) label = '1 Year 6 Months';
        else if (days === 730) label = '2 Years';
        else if (days === 910) label = '2 Years 6 Months';
        else if (days > 365 * 2) { // More than 2 years, roughly convert to years and months
             const years = Math.floor(days / 365);
             const remainingDays = days % 365;
             const months = Math.round(remainingDays / 30);
             if (months > 0) {
                label = `${years} Year${years !== 1 ? 's' : ''} ${months} Month${months !== 1 ? 's' : ''}`;
             } else {
                label = `${years} Year${years !== 1 ? 's' : ''}`;
             }
        }
        else if (days > 30) { // More than a month, convert to months
            const months = Math.round(days / 30);
            label = `${months} Month${months !== 1 ? 's' : ''}`;
        }
        else {
            label = `${days} Days`;
        }

        return { label: label, days: days, value: `${days}-Day` };
    });

    // Add 'All Delays' as the last option
    generatedRanges.push({ label: 'All Delays', days: Infinity, value: 'all' });
    return generatedRanges;
}

let minSliderIndex = 0;
let maxSliderIndex = 0;

// Initialize filters
function initializeFilters() {
    // Initialize slider ranges if not already done
    if (delayRanges.length === 0) {
        const maxTotalDelay = allData.reduce((max, item) => Math.max(max, item.TotalDelay || 0), 0);
        delayRanges = generateDynamicDelayRanges(maxTotalDelay);
    }

    // Initialize slider
    const delaySlider = document.getElementById('delaySlider');
    
    // Preserve current selection or default to 'all'
    let currentIndex = delayRanges.findIndex(r => r.value === selectedDelayRange);
    if (currentIndex === -1) {
        currentIndex = delayRanges.length - 1; // Default to 'all'
        selectedDelayRange = 'all';
    }

    delaySlider.min = 0;
    delaySlider.max = delayRanges.length - 1;
    delaySlider.value = currentIndex;

    updateSliderValue(); // Update display
}

// Generate average delay cards
function generateAverageDelayCards() {
    const averageDelayCardsContainer = document.getElementById('dashboardAverageDelayCards');
    averageDelayCardsContainer.innerHTML = '';

    const totalQtnDelay = allData.reduce((sum, item) => sum + (parseInt(item.DelayInQtn) || 0), 0);
    const totalWODelay = allData.reduce((sum, item) => sum + (parseInt(item.DelayInWO) || 0), 0);
    const totalSCDelay = allData.reduce((sum, item) => sum + (parseInt(item.DelayInSC) || 0), 0);
    const dataCount = allData.length;

    const avgQtnDelay = dataCount > 0 ? (totalQtnDelay / dataCount).toFixed(1) : 0;
    const avgWODelay = dataCount > 0 ? (totalWODelay / dataCount).toFixed(1) : 0;
    const avgSCDelay = dataCount > 0 ? (totalSCDelay / dataCount).toFixed(1) : 0;

    const createAverageCard = (title, value) => {
        const card = document.createElement('div');
        card.className = 'average-card';
        card.onclick = () => openBreakdownModal();
        card.innerHTML = `<h4>${title}</h4><div class="value">${value} Days</div>`;
        return card;
    };

    averageDelayCardsContainer.appendChild(createAverageCard('Avg Delay in Quotation', avgQtnDelay));
    averageDelayCardsContainer.appendChild(createAverageCard('Avg Delay in WO', avgWODelay));
    averageDelayCardsContainer.appendChild(createAverageCard('Avg Delay in Connection', avgSCDelay)); // Renamed from SC to Connection
}

function generateKpiAverageDelayCards() {
    const kpiAverageCardsContainer = document.getElementById('kpiAverageDelayCards');
    if (!kpiAverageCardsContainer) return;
    kpiAverageCardsContainer.innerHTML = '';

    const totalQtnDelay = allData.reduce((sum, item) => sum + (parseInt(item.DelayInQtn) || 0), 0);
    const totalWODelay = allData.reduce((sum, item) => sum + (parseInt(item.DelayInWO) || 0), 0);
    const totalSCDelay = allData.reduce((sum, item) => sum + (parseInt(item.DelayInSC) || 0), 0);
    const dataCount = allData.length;

    const avgQtnDelay = dataCount > 0 ? (totalQtnDelay / dataCount).toFixed(1) : 0;
    const avgWODelay = dataCount > 0 ? (totalWODelay / dataCount).toFixed(1) : 0;
    const avgSCDelay = dataCount > 0 ? (totalSCDelay / dataCount).toFixed(1) : 0;

    const createCard = (title, value) => `<div class="average-card"><h4>${title}</h4><div class="value">${value} Days</div></div>`;
    kpiAverageCardsContainer.innerHTML += createCard('Avg Delay in Quotation', avgQtnDelay);
    kpiAverageCardsContainer.innerHTML += createCard('Avg Delay in WO', avgWODelay);
    kpiAverageCardsContainer.innerHTML += createCard('Avg Delay in Connection', avgSCDelay);
}

function generateKpiSummaryTables() {
  const regionMap = {};
  const divisionMap = {};
  const cccMap = {};

  // Group data
  allData.forEach(d => {
    const r = d.REGION;
    const dv = d.DIVN_NAME;
    const cc = d.CCC_CODE;

    if (r) {
      if (!regionMap[r]) regionMap[r] = [];
      regionMap[r].push(d);
    }
    if (dv) {
      if (!divisionMap[dv]) divisionMap[dv] = [];
      divisionMap[dv].push(d);
    }
    if (cc) {
      if (!cccMap[cc]) cccMap[cc] = [];
      cccMap[cc].push(d);
    }
  });

  // Populate tables
  populateKpiTable(regionMap, 'kpiRegionTable');
  populateKpiTable(divisionMap, 'kpiDivisionTable');
  populateKpiTable(cccMap, 'kpiCCCTable', true); // use readable name
  generateKpiAverageDelayCards();
}

function populateKpiTable(dataMap, tableId, useCCCName = false) {
  const table = document.getElementById(tableId);
  const tbody = table.querySelector('tbody');
  const thead = table.querySelector('thead');
  tbody.innerHTML = '';

  // Build rows
  const rows = Object.entries(dataMap).map(([key, items]) => {
    const qtnAvg = average(items.map(i => parseInt(i.DelayInQtn) || 0));
    const woAvg = average(items.map(i => parseInt(i.DelayInWO) || 0));
    const connAvg = average(items.map(i => parseInt(i.DelayInSC) || 0));
    return {
      name: useCCCName ? (getCCCName(key) || key) : key,
      Qtn: qtnAvg,
      WO: woAvg,
      Conn: connAvg
    };
  });

  // --- Calculate Ranks ---
  const getRank = (value, sortedValues) => sortedValues.indexOf(value) + 1;
  const sortedQtn = [...new Set(rows.map(r => r.Qtn))].sort((a, b) => a - b);
  const sortedWO = [...new Set(rows.map(r => r.WO))].sort((a, b) => a - b);
  const sortedConn = [...new Set(rows.map(r => r.Conn))].sort((a, b) => a - b);


  // Sort handling
  const sortKey = table.dataset.sortKey || 'Conn';
  const sortDir = table.dataset.sortDir || 'asc';

  rows.sort((a, b) => {
    const valA = a[sortKey];
    const valB = b[sortKey];
    if (typeof valA === 'string') {
      return sortDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      return sortDir === 'asc' ? valA - valB : valB - valA;
    }
  });

  // Render rows
  rows.forEach(r => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td data-label="${useCCCName ? 'CCC' : tableId === 'kpiRegionTable' ? 'Region' : 'Division'}">${r.name}</td>
      <td data-label="Avg Quotation Delay">${r.Qtn.toFixed(1)} days <span class="rank-number">(${getRank(r.Qtn, sortedQtn)})</span></td>
      <td data-label="Avg WO Delay">${r.WO.toFixed(1)} days <span class="rank-number">(${getRank(r.WO, sortedWO)})</span></td>
      <td data-label="Avg Connection Delay">${r.Conn.toFixed(1)} days <span class="rank-number">(${getRank(r.Conn, sortedConn)})</span></td>
    `;
    tbody.appendChild(row);
  });

  // Set up click-to-sort once
  thead.querySelectorAll('th').forEach(th => {
    if (!th.dataset.listener) {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (!key) return;

        // Flip direction if same column
        const newDir = (table.dataset.sortKey === key && table.dataset.sortDir === 'asc') ? 'desc' : 'asc';
        table.dataset.sortKey = key;
        table.dataset.sortDir = newDir;

        populateKpiTable(dataMap, tableId, useCCCName);
      });
      th.dataset.listener = 'true';
    }
  });

  // Update arrow display
  thead.querySelectorAll('th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = '';
    const thKey = th.dataset.sort;
    if (thKey === sortKey) {
      th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = sortDir === 'asc' ? '▲' : '▼';
    }
  });
}



function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

// Setup event listeners
// Fixed event listener setup
function setupEventListeners() {
    const delaySlider = document.getElementById('delaySlider');

    delaySlider.addEventListener('input', () => {
        updateSliderValue(); // updates display while sliding
    });

    delaySlider.addEventListener('change', () => {
        // Get the current slider value and update selectedDelayRange
        const index = parseInt(delaySlider.value);
        const range = delayRanges[index];
        if (range) {
            selectedDelayRange = range.value; // ✅ UPDATE THE GLOBAL VARIABLE
        }
        
        // Re-initialize filters with new delay range
        initializeFilters();
        
        // Apply filters to get new filteredData
        applyFilters();
        
        // Update average delay cards
        generateAverageDelayCards();
        
        // Update KPI tables
        const filtered = filteredData; // Use the updated filteredData
        generateKpiAverageDelayCards();
        updateKpiTables(filtered);
    });
}



document.getElementById('kpiToggleBtn').addEventListener('click', () => {
    document.getElementById('kpiModal').style.display = 'block';
});

window.closeKpiModal = function() {
    document.getElementById('kpiModal').style.display = 'none';
};

// --- NEW: Functions for Breakdown Modal ---

function openBreakdownModal() {
    const modal = document.getElementById('breakdownModal');
    modal.style.display = 'block';

    // Populate tables inside the new modal
    const regionMap = {}, divisionMap = {}, cccMap = {};
    const dataToUse = filteredData.length > 0 ? filteredData : allData;

    dataToUse.forEach(d => {
        if (d.REGION) (regionMap[d.REGION] = regionMap[d.REGION] || []).push(d);
        if (d.DIVN_NAME) (divisionMap[d.DIVN_NAME] = divisionMap[d.DIVN_NAME] || []).push(d);
        if (d.CCC_CODE) (cccMap[d.CCC_CODE] = cccMap[d.CCC_CODE] || []).push(d);
    });

    // Populate tables with new IDs
    populateKpiTable(regionMap, 'modalRegionTable');
    populateKpiTable(divisionMap, 'modalDivisionTable');
    populateKpiTable(cccMap, 'modalCCCTable', true);

    // Ensure the first tab is active
    openTab({ currentTarget: document.querySelector('.tab-link') }, 'RegionTab');
}

function closeBreakdownModal() {
    document.getElementById('breakdownModal').style.display = 'none';
}

function openTab(evt, tabName) {
    let i, tabcontent, tablinks;

    // Hide all tab content
    tabcontent = document.getElementsByClassName("tab-content");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }

    // Remove "active" class from all tab links
    tablinks = document.getElementsByClassName("tab-link");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }

    // Show the current tab and add an "active" class to the button that opened the tab
    document.getElementById(tabName).style.display = "block";
    if (evt && evt.currentTarget) {
        evt.currentTarget.className += " active";
    }
}

// Add a unique ID to the dashboard's average card container in the HTML
document.addEventListener('DOMContentLoaded', () => {
    const mainCardsContainer = document.querySelector('.main-content .container > .average-delay-cards');
    if (mainCardsContainer) {
        mainCardsContainer.id = 'dashboardAverageDelayCards';
    }
});



// Update slider value display
// Fixed updateSliderValue function
function updateSliderValue() {
    const slider = document.getElementById('delaySlider');
    const valueLabel = document.getElementById('sliderValue');
    const leftLabel = document.getElementById('sliderLeftLabel');
    const rightLabel = document.getElementById('sliderRightLabel');

    if (!delayRanges || delayRanges.length === 0) return;

    const index = parseInt(slider.value);
    const range = delayRanges[index];
    if (!range) return;

    valueLabel.textContent = range.label;

    // ✅ Use the range days for filtering preview
    const filtered = allData.filter(d => {
        const totalDelay = d.TotalDelay || 0;
        return range.days === Infinity ? true : totalDelay <= range.days;
    });
    
    const filteredCount = filtered.length;
    const excludedCount = allData.length - filteredCount;

    const pct = x => Math.round((x / allData.length) * 100);

    leftLabel.textContent = `${filteredCount} (${pct(filteredCount)}%)`;
    rightLabel.textContent = `${excludedCount} (${pct(excludedCount)}%)`;
}


// Add missing updateKpiTables function
function updateKpiTables(filteredData) {
    const regionMap = {};
    const divisionMap = {};
    const cccMap = {};

    // Group filtered data
    filteredData.forEach(d => {
        const r = d.REGION;
        const dv = d.DIVN_NAME;
        const cc = d.CCC_CODE;

        if (r) {
            if (!regionMap[r]) regionMap[r] = [];
            regionMap[r].push(d);
        }
        if (dv) {
            if (!divisionMap[dv]) divisionMap[dv] = [];
            divisionMap[dv].push(d);
        }
        if (cc) {
            if (!cccMap[cc]) cccMap[cc] = [];
            cccMap[cc].push(d);
        }
    });

    // Update tables with filtered data
    populateKpiTable(regionMap, 'kpiRegionTable');
    populateKpiTable(divisionMap, 'kpiDivisionTable');
    populateKpiTable(cccMap, 'kpiCCCTable', true);
    populateKpiTable(cccMap, 'kpiCCCTable', true);
}


// Apply all filters
// Fixed applyFilters function
function applyFilters() {
    filteredData = allData.filter(item => {
        // Delay filter - FIXED LOGIC
        if (selectedDelayRange !== 'all') {
            const selectedRange = delayRanges.find(r => r.value === selectedDelayRange);
            if (selectedRange) {
                const maxDays = selectedRange.days;
                if (item.TotalDelay > maxDays) return false;
            }
        }
        return true;
    });

    // Refresh current view based on currentLevel
    if (currentLevel === 'region') {
        showRegionCards();
    } else if (currentLevel === 'division') {
        showDivisionCards();
    } else if (currentLevel === 'ccc') {
        showCCCCards();
    } else if (currentLevel === 'dashboard') {
        const dashboardData = filteredData.filter(item =>
            item.REGION === selectedRegion &&
            item.DIVN_NAME === selectedDivision &&
            item.CCC_CODE === selectedCCC
        );
        updateDashboardCards(dashboardData); // ✅ Update dashboard cards
    }

    return filteredData; // ✅ Return filtered data for other functions
}

// Show region cards
function showRegionCards() {
    currentLevel = 'region';
    updateBreadcrumb([{text: 'Select Region', level: 'region', active: true}]);
    const regions = [...new Set(filteredData.map(item => item.REGION))].filter(Boolean);
    const cardsContainer = document.getElementById('cardsContainer');
    const dashboardCards = document.getElementById('dashboardCards');

    // Hide all modals when going back to this level
    document.getElementById('subDashboardModal').style.display = 'none';
    document.getElementById('consumerModal').style.display = 'none';
    dashboardCards.style.display = 'none';
    cardsContainer.innerHTML = '';
    cardsContainer.style.display = 'grid'; // Ensure cards container is visible

    regions.forEach(region => {
        const count = filteredData.filter(item => item.REGION === region).length;
        const card = createCard(region, `${count} applications`, () => selectRegion(region));
        cardsContainer.appendChild(card);
    });
}

// Show division cards
function showDivisionCards() {
    currentLevel = 'division';
    updateBreadcrumb([
        {text: 'Regions', level: 'region', active: false},
        {text: selectedRegion, level: 'division', active: true}
    ]);
    const divisions = [...new Set(filteredData
        .filter(item => item.REGION === selectedRegion)
        .map(item => item.DIVN_NAME))].filter(Boolean);
    const cardsContainer = document.getElementById('cardsContainer');
    const dashboardCards = document.getElementById('dashboardCards');

    // Hide all modals when going back to this level
    document.getElementById('subDashboardModal').style.display = 'none';
    document.getElementById('consumerModal').style.display = 'none';
    dashboardCards.style.display = 'none';
    cardsContainer.innerHTML = '';
    cardsContainer.style.display = 'grid'; // Ensure cards container is visible

    divisions.forEach(division => {
        const count = filteredData.filter(item => item.REGION === selectedRegion && item.DIVN_NAME === division ).length;
        const card = createCard(division, `${count} applications`, () => selectDivision(division));
        cardsContainer.appendChild(card);
    });
}

// Show CCC cards
function showCCCCards() {
    currentLevel = 'ccc';
    updateBreadcrumb([
        {text: 'Regions', level: 'region', active: false},
        {text: selectedRegion, level: 'division', active: false},
        {text: selectedDivision, level: 'ccc', active: true}
    ]);
    const cccs = [...new Set(filteredData
        .filter(item => item.REGION === selectedRegion && item.DIVN_NAME === selectedDivision)
        .map(item => item.CCC_CODE))].filter(Boolean);
    const cardsContainer = document.getElementById('cardsContainer');
    const dashboardCards = document.getElementById('dashboardCards');

    // Hide all modals when going back to this level
    document.getElementById('subDashboardModal').style.display = 'none';
    document.getElementById('consumerModal').style.display = 'none';
    dashboardCards.style.display = 'none';
    cardsContainer.innerHTML = '';
    cardsContainer.style.display = 'grid'; // Ensure cards container is visible

    cccs.forEach(ccc => {
        const cccName = getCCCName(ccc);
        const count = filteredData.filter(item => item.REGION === selectedRegion && item.DIVN_NAME === selectedDivision && item.CCC_CODE === ccc ).length;
        const card = createCard(cccName, `${count} applications`, () => selectCCC(ccc, cccName));
        cardsContainer.appendChild(card);
    });
}

// Helper to get CCC name from code
function getCCCName(cccCode) {
    const item = allData.find(d => d.CCC_CODE === cccCode);
    return item ? item.SUPP_OFF : cccCode; // Assuming SUPP_OFF is the readable name
}

// Select Region
function selectRegion(region) {
    selectedRegion = region;
    selectedDivision = ''; // Reset division and CCC when new region is selected
    selectedCCC = '';
    showDivisionCards();
}

// Select Division
function selectDivision(division) {
    selectedDivision = division;
    selectedCCC = ''; // Reset CCC when new division is selected
    showCCCCards();
}

// Select CCC
function selectCCC(cccCode, cccName) {
    selectedCCC = cccCode;
    selectedCCCName = cccName;
    showDashboard();
}

// Show Dashboard (detailed view for selected CCC)
function showDashboard() {
    currentLevel = 'dashboard';
    updateBreadcrumb([
        {text: 'Regions', level: 'region', active: false},
        {text: selectedRegion, level: 'division', active: false},
        {text: selectedDivision, level: 'ccc', active: false},
        {text: selectedCCCName, level: 'dashboard', active: true}
    ]);

    const dashboardData = filteredData.filter(item =>
        item.REGION === selectedRegion &&
        item.DIVN_NAME === selectedDivision &&
        item.CCC_CODE === selectedCCC
    );

    const cardsContainer = document.getElementById('cardsContainer');
    const dashboardCards = document.getElementById('dashboardCards');
    cardsContainer.style.display = 'none'; // Hide region/division/ccc cards
    dashboardCards.style.display = 'grid'; // Show dashboard cards
 dashboardCards.innerHTML = '';

const countByField = (key, value) => dashboardData.filter(item => item[key] === value).length;

const cardSpecs = [
    { title: "Class-wise", count: new Set(dashboardData.map(d => d.CONN_CLASS)).size, label: "Class count", key: 'class' },
    { title: "Agency-wise", count: new Set(dashboardData.map(d => d.AGENCY_NAME)).size, label: "Agency count", key: 'agency' },
{ title: "Pending Duare Sarkar", count: dashboardData.filter(d => d.IS_DUARE_SARKAR === 'Y').length, label: "Applications", key: 'pendingDuare' },
    { title: "Pending WO", count: dashboardData.filter(d => d.WO_ISSUED === 'N').length, label: "Applications", key: 'pendingWO' },
    { title: "Pole Case", count: dashboardData.filter(d => d.PoleNonPole === 'Pole Case').length, label: "Applications", key: 'pole' },
    { title: "Non-POle Case", count: dashboardData.filter(d => d.PoleNonPole === 'Non Pole Case').length, label: "Applications", key: 'nonPole' },
{ title: "Industrial", count: dashboardData.filter(d => d.CONN_CLASS === 'I').length, label: "Applications", key: 'industrial' },
    { title: "Total 3-Ph", count: dashboardData.filter(d => d.APPLIED_PHASE === 'III').length, label: "Applications", key: '3ph' },
];





cardSpecs.forEach(({ title, count, label, key }) => {
    const card = document.createElement('div');
    card.className = 'dashboard-card compact';
    card.id = `dashboard-card-${key}`; // ✅ Add this ID for targeting
    card.innerHTML = `<h4>${title}</h4><div class="count">${count}</div><div class="label">${label}</div>`;

    card.addEventListener('click', () => {
        const data = dashboardData;

        if (key === 'class') {
            showGroupedBreakdownModal('Class-wise Applications', 'CONN_CLASS', data);
        } else if (key === 'agency') {
            showGroupedBreakdownModal('Agency-wise Applications', 'AGENCY_NAME', data);
        } else {
            const filtered = filterDashboardDataByKey(key, data);
            showSimpleConsumerList(title, filtered);
        }
    });

    dashboardCards.appendChild(card);
});

// ✅ Add this line just after all cards are created:
updateDashboardCards(dashboardData);



function filterDashboardDataByKey(key, data) {
    switch (key) {
        case 'pendingDuare':
            return data.filter(d => d.IS_DUARE_SARKAR === 'Y');
        case 'pendingWO':
            return data.filter(d => d.WO_ISSUED === 'N');
        case 'pole':
            return data.filter(d => d.PoleNonPole === 'Pole Case');
        case 'nonPole':
            return data.filter(d => d.PoleNonPole === 'Non Pole Case');
case 'industrial':
    return data.filter(d => d.CONN_CLASS === 'I');

        case '3ph':
            return data.filter(d => d.APPLIED_PHASE === 'III');
        default:
            return [];
    }
}
function showSimpleConsumerList(title, data) {
    const subModal = document.getElementById('subDashboardModal');
    const subModalTitle = document.getElementById('subModalTitle');
    const subDashboardList = document.getElementById('subDashboardList');

subModalTitle.textContent = `${selectedCCCName} — ${title} (${data.length})`;
    subDashboardList.innerHTML = '';

const sorted = data.sort((a, b) => (parseInt(b.DelayInSC || 0)) - (parseInt(a.DelayInSC || 0)));

const table = document.createElement('table');
table.className = 'consumer-table';

table.innerHTML = `
    <thead>
        <tr>
            <th>Name</th>
            <th>Application No</th>
            <th>Phone</th>
            <th>Delay (Days)</th>
            <th>Class</th>
            <th style="padding-left: 40px;">No. of Poles</th>
            <th>Details</th>
        </tr>
    </thead>
    <tbody></tbody>
`;

const tbody = table.querySelector('tbody');

sorted.forEach(item => {
    const row = tbody.insertRow();
    row.insertCell().textContent = item.NAME || '';
    row.insertCell().textContent = item.APPL_NO || '';
    row.insertCell().textContent = item.PHONE_NO || '';
    row.insertCell().textContent = item.DelayInSC || 0;
    row.insertCell().textContent = item.CONN_CLASS || 'N/A';
row.insertCell().textContent = item.NO_OF_POLES || '0';

    const detailsCell = row.insertCell();
    const btn = document.createElement('button');
    btn.textContent = 'Details';
    btn.className = 'details-button';
    btn.addEventListener('click', () => showConsumerDetails(item.APPL_NO));
    detailsCell.appendChild(btn);
});

subDashboardList.appendChild(table);


    subModal.style.display = 'block';
}
function showGroupedBreakdownModal(title, key, data) {
    const subModal = document.getElementById('subDashboardModal');
    const subModalTitle = document.getElementById('subModalTitle');
    const subDashboardList = document.getElementById('subDashboardList');

    subModalTitle.textContent = title;
    subDashboardList.innerHTML = '';
    groupedModalDataMap = {}; // Reset previous

const groupMap = {};
data.forEach(d => {
    let val = d[key];
    if (!val || val.trim() === '') {
        val = 'WO Pending';
        d._isWOPending = true;
    }
    if (!groupMap[val]) groupMap[val] = [];
    groupMap[val].push(d);
});

Object.entries(groupMap)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([group, items], index) => {
        const groupId = `group-${key}-${index}`;
        groupedModalDataMap[groupId] = items;

        const card = document.createElement('div');
        card.className = 'sub-dashboard-card';
        card.innerHTML = `
            <div>
                <h4 style="color: ${group === 'WO Pending' ? 'red' : '#2c3e50'};">${group}</h4>
                <p><strong>Count:</strong> ${items.length}</p>
            </div>
            <button class="details-button" data-groupid="${groupId}" data-groupname="${group}">View</button>
        `;
        subDashboardList.appendChild(card);
    });


    // Attach dynamic event listeners
    subDashboardList.querySelectorAll('button[data-groupid]').forEach(button => {
        button.addEventListener('click', () => {
            const groupId = button.getAttribute('data-groupid');
            const groupName = button.getAttribute('data-groupname');
            const items = groupedModalDataMap[groupId];
            if (items) {
                showSimpleConsumerList(`${title} - ${groupName}`, items);
            }
        });
    });

    subModal.style.display = 'block';
}


    // Create dashboard cards
    const createDashboardCard = (title, count, label, onClick = null) => {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.innerHTML = `<h4>${title}</h4><div class="count">${count}</div><div class="label">${label}</div>`;
        if (onClick) {
            card.style.cursor = 'pointer';
            card.addEventListener('click', onClick);
        }
        return card;
    };

    dashboardCards.appendChild(createDashboardCard('Total Applications', totalApplications, 'All applications'));
    dashboardCards.appendChild(createDashboardCard('Pending Applications', pendingApplications, 'Applications awaiting connection', () => showSubDashboard('Pending', dashboardData.filter(item => item.SCN_STATUS === 'Pending'))));
    dashboardCards.appendChild(createDashboardCard('Completed Applications', completedApplications, 'Applications successfully connected', () => showSubDashboard('Completed', dashboardData.filter(item => item.SCN_STATUS === 'Working'))));

    // Add cards for categories
    Object.entries(delayCategories).sort((a,b) => (b[1] - a[1])).forEach(([range, count]) => {
        dashboardCards.appendChild(createDashboardCard(`Delay: ${range}`, count, 'applications', () => showSubDashboard(`Delay: ${range}`, dashboardData.filter(item => item.DelayRange === range))));
    });

    Object.entries(applicantTypes).sort((a,b) => (b[1] - a[1])).forEach(([type, count]) => {
        dashboardCards.appendChild(createDashboardCard(`Applicant Type: ${type}`, count, 'applications', () => showSubDashboard(`Applicant Type: ${type}`, dashboardData.filter(item => item.APPLICANT_TYPE === type))));
    });

    Object.entries(connectionClasses).sort((a,b) => (b[1] - a[1])).forEach(([cls, count]) => {
        dashboardCards.appendChild(createDashboardCard(`Connection Class: ${cls}`, count, 'applications', () => showSubDashboard(`Connection Class: ${cls}`, dashboardData.filter(item => item.CONN_CLASS === cls))));
    });

    Object.entries(poleNonPoleCases).sort((a,b) => (b[1] - a[1])).forEach(([type, count]) => {
        dashboardCards.appendChild(createDashboardCard(`Pole/Non-Pole: ${type}`, count, 'applications', () => showSubDashboard(`Pole/Non-Pole: ${type}`, dashboardData.filter(item => item.PoleNonPole === type))));
    });
}

// Show Sub-Dashboard (list of applications for a specific category)
function showSubDashboard(title, data) {
    const subModal = document.getElementById('subDashboardModal');
    const subModalTitle = document.getElementById('subModalTitle');
    const subDashboardList = document.getElementById('subDashboardList');

    subModalTitle.textContent = `${title} Applications`;
    subDashboardList.innerHTML = ''; // Clear previous list

    if (data.length === 0) {
        subDashboardList.innerHTML = '<p class="no-data-message">No applications found for this category.</p>';
    } else {
        data.forEach(item => {
const card = document.createElement('div');
card.className = 'dashboard-card compact';
card.id = `dashboard-card-${key}`; // <-- Unique ID per card
card.innerHTML = `<h4>${title}</h4><div class="count">${count}</div><div class="label">${label}</div>`;

            subDashboardList.appendChild(card);
        });
    }
    subModal.style.display = 'block';
}
function updateDashboardCards(dashboardData) {
    const updatedSpecs = [
        { key: 'class', count: new Set(dashboardData.map(d => d.CONN_CLASS)).size },
        { key: 'agency', count: new Set(dashboardData.map(d => d.AGENCY_NAME)).size },
{ key: 'pendingDuare', count: dashboardData.filter(d => d.IS_DUARE_SARKAR === 'Y').length },
        { key: 'pendingWO', count: dashboardData.filter(d => d.WO_ISSUED === 'N').length },
        { key: 'pole', count: dashboardData.filter(d => d.PoleNonPole === 'Pole Case').length },
        { key: 'nonPole', count: dashboardData.filter(d => d.PoleNonPole === 'Non Pole Case').length },
{ key: 'industrial', count: dashboardData.filter(d => d.CONN_CLASS === 'I').length },
        { key: '3ph', count: dashboardData.filter(d => d.APPLIED_PHASE === 'III').length },
    ];

    updatedSpecs.forEach(({ key, count }) => {
        const card = document.getElementById(`dashboard-card-${key}`);
        if (card) {
            const countDiv = card.querySelector('.count');
            const oldValue = parseInt(countDiv.textContent);
            if (oldValue !== count) {
                countDiv.textContent = count;
                card.classList.add('highlight'); // Optional animation class
                setTimeout(() => card.classList.remove('highlight'), 500); // brief animation
            }
        }
    });
}

// Close sub-dashboard modal
function closeSubModal() {
    document.getElementById('subDashboardModal').style.display = 'none';
}

// Show consumer details modal
function showConsumerDetails(applNo) {
    const consumer = allData.find(item => item.APPL_NO === applNo);
    if (!consumer) return;

    const modal = document.getElementById('consumerModal'); // ✅ FIXED LINE
    const consumerTableBody = document.getElementById('consumerTableBody'); // also required
    

    consumerTableBody.innerHTML = ''; // Clear previous details

    function addRow(label1, value1, label2 = '', value2 = '') {
        const row = consumerTableBody.insertRow();
        row.insertCell().textContent = label1;
        row.insertCell().textContent = value1 || 'N/A';
        if (label2) {
            row.insertCell().textContent = label2;
            row.insertCell().textContent = value2 || 'N/A';
        } else {
            row.insertCell().colSpan = 2;
        }
    }

    // 🔹 Basic Info
    addRow('Name:', consumer.NAME, 'Application No:', consumer.APPL_NO);
    addRow('Consumer ID:', consumer.CON_ID, 'Phone No:', consumer.PHONE_NO);
    addRow('Address:', consumer.ADDRESS, 'Division:', consumer.DIVN_NAME);
    addRow('CCC (Supp Off):', consumer.SUPP_OFF);

    // 🔹 Application Details
    addRow('Creation Date:', consumer.CREATION_DATE, 'Applicant Type:', consumer.APPLICANT_TYPE);
    addRow('Load (Watts):', consumer.LOAD_WATTS, 'Applied Phase:', consumer.APPLIED_PHASE);
    addRow('Connection Class:', consumer.CONN_CLASS, 'Connection Category:', consumer.CONN_CAT);
    addRow('No. of Poles:', consumer.NO_OF_POLES, 'Turn Key:', consumer.TURN_KEY);

    // 🔹 Work Order
    addRow('Quotation Issue Date:', consumer.QUOTATION_ISSUE_DATE, 'Collection Date:', consumer.COLL_DATE);
    addRow('WO Issued:', consumer.WO_ISSUED, 'WO Number:', consumer.WON);
    addRow('WO Creation Date:', consumer.WO_CREATION_DATE, 'Agency Name:', consumer.AGENCY_NAME);

    // 🔹 SCN Info
    addRow('Meter Number:', consumer.METER_NUMBER, 'SCN Status:', consumer.SCN_STATUS);
    addRow('SCN Withheld Date:', consumer.SCN_WITHELD_DATE, 'SCN Withheld Reason:', consumer.SCN_WITHELD_REASON);

    // 🔹 Special Programs
    addRow('Is Duare Sarkar:', consumer.IS_DUARE_SARKAR, 'DS Number:', consumer.DS_NUMBER);
    addRow('Is Portal Application:', consumer.IS_PORTAL_APPL);

    // 🔹 Delay Metrics
    addRow('Delay in WO:', `${consumer.DelayInWO || 0} Days`, 'Delay in SC:', `${consumer.DelayInSC || 0} Days`);
    addRow('Delay in Quotation:', `${consumer.DelayInQtn || 0} Days`);

    modal.style.display = 'block'; // ✅ Show modal now works
}


// Close consumer details modal
function closeModal() {
    document.getElementById('consumerModal').style.display = 'none';
}

// Helper function to create cards
function createCard(title, description, onClick) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        <h3>${title}</h3>
        <p>${description}</p>
    `;
    card.addEventListener('click', onClick);
    return card;
}

// Update breadcrumb navigation
function updateBreadcrumb(items) {
    const breadcrumbContainer = document.getElementById('breadcrumb');
    breadcrumbContainer.innerHTML = '';
    items.forEach(item => {
        const span = document.createElement('span');
        span.className = `breadcrumb-item ${item.active ? 'active' : ''}`;
        span.textContent = item.text;
        if (!item.active) {
            span.addEventListener('click', () => navigateBreadcrumb(item.level));
        }
        breadcrumbContainer.appendChild(span);
    });
}

// Navigate breadcrumb
function navigateBreadcrumb(level) {
    if (level === 'region') {
        selectedRegion = '';
        selectedDivision = '';
        selectedCCC = '';
        showRegionCards();
    } else if (level === 'division') {
        selectedDivision = '';
        selectedCCC = '';
        showDivisionCards();
    } else if (level === 'ccc') {
        selectedCCC = '';
        showCCCCards();
    }
}


// Date formatting utility (if needed)
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    // Assuming dateString is DD/MM/YYYY
    const parts = dateString.split('/');
    if (parts.length === 3) {
        const date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        return date.toLocaleDateString('en-GB');
    }
    return dateString; // Return as is if format is unexpected
}

function calculateDelay(startDateStr, endDateStr) {
    if (!startDateStr || !endDateStr) return 0;

    // Convert DD/MM/YYYY to YYYY-MM-DD for reliable Date object creation
    const parseDate = (dateString) => {
        const parts = dateString.split('/');
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    };

    try {
        const start = parseDate(startDateStr);
        const end = parseDate(endDateStr);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            console.warn('Invalid date detected during delay calculation:', startDateStr, endDateStr);
            return 0;
        }

        const diffTime = Math.abs(end.getTime() - start.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    } catch (e) {
        console.error('Error calculating delay:', e);
        return 0;
    }
}
