// Global variables for KPI page
let allData = [];
let filteredData = [];

// --- NEW: State for class filters ---
let selectedClasses = new Set();

document.addEventListener('DOMContentLoaded', function() {
    loadData();
    setupEventListeners();
});

// Update the "Updated up to" date in the subtitle
function updateMaxTodayDate(data) {
    const subtitleSpan = document.getElementById('todayDateSubtitle');
    if (!subtitleSpan) return; 
    const validDates = data.filter(d => d.TODAY).map(d => {
        const parts = d.TODAY.split('/');
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    });

    if (validDates.length > 0) {
        const maxDate = new Date(Math.max(...validDates));
        subtitleSpan.textContent = maxDate.toLocaleDateString('en-GB');
    } else {
        subtitleSpan.textContent = 'No data';
    }
}

async function loadNscDataset() {
    const urls = [
        '/api/nsc/dataset',
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vRsUU2viBvYhSgR0RFwmZ1H8LkYCats9roQVCKvQeoU7dzg6ryR6IWZex9FT9tksp_DEM23ZgQ28Iyo/pub?output=csv'
    ];
    for (const url of urls) {
        try {
            const response = await fetch(url, { credentials: url.startsWith('/') ? 'same-origin' : 'omit' });
            if (!response.ok) continue;
            const text = (await response.text()).trim();
            if (!text) continue;
            if (text.startsWith('[')) return JSON.parse(text);
            if (typeof Papa === 'undefined') continue;
            const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
            if (parsed && parsed.data && parsed.data.length) return parsed.data;
        } catch (err) {
            console.warn('NSC load failed for', url, err);
        }
    }
    return [];
}

async function loadData() {
    const subtitle = document.getElementById('todayDateSubtitle');
    try {
        if (subtitle) subtitle.textContent = 'Loading…';
        allData = await loadNscDataset();
        if (window.MzoScope) allData = window.MzoScope.filterRows(allData);
        if (!allData.length) {
            if (subtitle) subtitle.textContent = 'No data';
            const cards = document.getElementById('averageDelayCards');
            if (cards) {
                cards.innerHTML = '<p style="padding:12px;color:#64748b;">No NSC rows for this login. Publish NSC or check office scope.</p>';
            }
            return;
        }
        processData();
    } catch (error) {
        console.error('Error loading NSC KPI data:', error);
        if (subtitle) subtitle.textContent = 'Failed to load';
        const cards = document.getElementById('averageDelayCards');
        if (cards) {
            cards.innerHTML = '<p style="padding:12px;color:#b91c1c;">' + (error && error.message ? error.message : 'Failed to load NSC data.') + '</p>';
        }
    }
}

// Process data after loading
function processData() {
    allData = allData.map(item => ({
        ...item,
        TotalDelay: (parseInt(item.DelayInWO) || 0) + (parseInt(item.DelayInSC) || 0) + (parseInt(item.DelayInQtn) || 0)
    }));

    filteredData = [...allData];
    updateMaxTodayDate(allData);
    initializeFilters();
    if (window.MzoScope) window.MzoScope.lockFilters();

    applyFilters();
}

// Initialize class and delay filters
function initializeFilters() {
    // --- NEW: Initialize class checkboxes ---
    const classes = [...new Set(allData.map(item => item.CONN_CLASS))].filter(Boolean).sort();
    const checkboxContainer = document.getElementById('classCheckboxes');
    checkboxContainer.innerHTML = '';

    // Initially select all classes
    classes.forEach(className => selectedClasses.add(className));

    // "All" button
    const allItem = document.createElement('div');
    allItem.className = 'checkbox-item active';
    allItem.innerHTML = `<label>All</label>`;
    allItem.addEventListener('click', () => {
        const allCurrentlyChecked = selectedClasses.size === classes.length;
        checkboxContainer.querySelectorAll('.checkbox-item').forEach(item => {
            const className = item.dataset.class;
            if (allCurrentlyChecked) { // Uncheck all
                if (className) {
                    selectedClasses.delete(className);
                    item.classList.remove('active');
                }
            } else { // Check all
                if (className) selectedClasses.add(className);
                item.classList.add('active');
            }
        });
        allItem.classList.toggle('active', !allCurrentlyChecked);
        applyFilters();
    });
    checkboxContainer.appendChild(allItem);

    // Individual class checkboxes
    classes.forEach(className => {
        const checkboxItem = document.createElement('div');
        checkboxItem.className = 'checkbox-item active';
        checkboxItem.dataset.class = className;
        checkboxItem.innerHTML = `<label>${className}</label>`;
        checkboxItem.addEventListener('click', () => {
            checkboxItem.classList.toggle('active');
            if (checkboxItem.classList.contains('active')) {
                selectedClasses.add(className);
            } else {
                selectedClasses.delete(className);
            }
            // Update "All" button state
            const allChecked = selectedClasses.size === classes.length;
            checkboxContainer.querySelector('.checkbox-item:not([data-class])').classList.toggle('active', allChecked);
            applyFilters();
        });
        checkboxContainer.appendChild(checkboxItem);
    });
}

// Setup event listeners for filters
function setupEventListeners() {
    // Event listeners for other filters can be added here if needed in the future.
}
function applyFilters() {
    filteredData = allData.filter(item => {
        if (selectedClasses.size > 0) {
            const cls = String(item.CONN_CLASS == null ? '' : item.CONN_CLASS).trim();
            if (cls && !selectedClasses.has(cls) && !selectedClasses.has(item.CONN_CLASS)) return false;
        }
        return true;
    });
    updateDashboard(filteredData);
}

function updateDashboard(data) {
    updateAverageDelayCards(data);
    updateKpiTables(data);
}

/** Most specific office grain: ccc | division | region */
function getKpiSummaryLevel() {
    if (window.MzoScope && typeof window.MzoScope.getScope === 'function') {
        const scope = window.MzoScope.getScope();
        if (scope && !scope.unscoped) {
            if (scope.level === 'ccc' || scope.level === 'codes') return 'ccc';
            if (scope.level === 'division') return 'division';
            if (scope.level === 'region') return 'region';
        }
    }
    return 'region';
}

function applyKpiSummaryVisibility(level) {
    const showRegion = level === 'region';
    const showDivision = level === 'region' || level === 'division';
    const regionBlock = document.getElementById('kpiRegionBlock');
    const divBlock = document.getElementById('kpiDivisionBlock');
    const cccBlock = document.getElementById('kpiCCCBlock');
    if (regionBlock) regionBlock.style.display = showRegion ? '' : 'none';
    if (divBlock) divBlock.style.display = showDivision ? '' : 'none';
    if (cccBlock) cccBlock.style.display = '';

    document.querySelectorAll('[data-kpi-tab]').forEach((btn) => {
        const tab = btn.getAttribute('data-kpi-tab');
        const show = tab === 'ccc' || (tab === 'division' && showDivision) || (tab === 'region' && showRegion);
        btn.style.display = show ? '' : 'none';
    });
}

function defaultBreakdownTab(level) {
    if (level === 'ccc') return 'CCCTab';
    if (level === 'division') return 'DivisionTab';
    return 'RegionTab';
}

// Update the average delay cards
function updateAverageDelayCards(data) {
    const container = document.getElementById('averageDelayCards');
    container.innerHTML = '';
    const dataCount = data.length;

    const avgQtnDelay = dataCount > 0 ? average(data.map(item => parseInt(item.DelayInQtn) || 0)) : 0;
    const avgWODelay = dataCount > 0 ? average(data.map(item => parseInt(item.DelayInWO) || 0)) : 0;
    const avgSCDelay = dataCount > 0 ? average(data.map(item => parseInt(item.DelayInSC) || 0)) : 0;

    const createCard = (title, value, delayType) => {
        const card = document.createElement('div');
        card.className = 'average-card';
        card.onclick = () => openBreakdownModal(title, delayType); // Pass title and delay type
        card.innerHTML = `<h4>${title}</h4><div class="value">${value.toFixed(1)} Days</div>`;
        return card;
    };

    container.appendChild(createCard('Quotation Delay', avgQtnDelay, 'Qtn'));
    container.appendChild(createCard('WO Delay', avgWODelay, 'WO'));
    container.appendChild(createCard('Conn Delay', avgSCDelay, 'Conn'));
}

// Update all KPI summary tables
function updateKpiTables(data) {
    const regionMap = {}, divisionMap = {}, cccMap = {};

    data.forEach(d => {
        if (d.REGION) (regionMap[d.REGION] = regionMap[d.REGION] || []).push(d);
        if (d.DIVN_NAME) (divisionMap[d.DIVN_NAME] = divisionMap[d.DIVN_NAME] || []).push(d);
        if (d.CCC_CODE) (cccMap[d.CCC_CODE] = cccMap[d.CCC_CODE] || []).push(d);
    });

    populateKpiTable(regionMap, 'kpiRegionTable');
    populateKpiTable(divisionMap, 'kpiDivisionTable');
    addTableHeaders('modalRegionTable', 'Region');
    addTableHeaders('modalDivisionTable', 'Division');
    addTableHeaders('modalCCCTable', 'CCC');
    populateKpiTable(cccMap, 'kpiCCCTable', true);
    applyKpiSummaryVisibility(getKpiSummaryLevel());
}

// Populate a single KPI table with data
function populateKpiTable(dataMap, tableId, useCCCName = false, delayType = null) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return; // Safety check
    tbody.innerHTML = '';

    let rows = Object.entries(dataMap).map(([key, items]) => {
        const name = useCCCName ? (getCCCName(key) || key) : key;
        const Qtn = average(items.map(i => parseInt(i.DelayInQtn) || 0));
        const WO = average(items.map(i => parseInt(i.DelayInWO) || 0));
        const Conn = average(items.map(i => parseInt(i.DelayInSC) || 0));
        return { name, Qtn, WO, Conn };
    });

    // --- Calculate Ranks ---
    const getRank = (value, sortedValues) => sortedValues.indexOf(value) + 1;
    const sortedQtn = [...new Set(rows.map(r => r.Qtn))].sort((a, b) => a - b);
    const sortedWO = [...new Set(rows.map(r => r.WO))].sort((a, b) => a - b);
    const sortedConn = [...new Set(rows.map(r => r.Conn))].sort((a, b) => a - b);

    // --- Sorting ---
    const sortKey = table.dataset.sortKey || delayType || 'Conn';
    const sortDir = table.dataset.sortDir || 'asc';

    rows.sort((a, b) => {
        const valA = a[sortKey], valB = b[sortKey];
        if (typeof valA === 'string') {
            return sortDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return sortDir === 'asc' ? valA - valB : valB - valA;
    });

    rows.forEach(r => {
        const row = tbody.insertRow();
        const nameHeader = useCCCName ? 'CCC' : (tableId.includes('Region') ? 'Region' : 'Division');

        if (delayType) {
            const delayValue = r[delayType].toFixed(1);
            const rank = getRank(r[delayType], delayType === 'Qtn' ? sortedQtn : (delayType === 'WO' ? sortedWO : sortedConn));
            row.innerHTML = `
                <td data-label="${nameHeader}">${r.name}</td>
                <td data-label="Average Delay">${delayValue} days <span class="rank-number">(${rank})</span></td>`;
        } else {
            row.innerHTML = `
                <td data-label="${nameHeader}">${r.name}</td>
                <td data-label="Qtn Delay">${r.Qtn.toFixed(1)} days <span class="rank-number">(${getRank(r.Qtn, sortedQtn)})</span></td>
                <td data-label="WO Delay">${r.WO.toFixed(1)} days <span class="rank-number">(${getRank(r.WO, sortedWO)})</span></td>
                <td data-label="Conn Delay">${r.Conn.toFixed(1)} days <span class="rank-number">(${getRank(r.Conn, sortedConn)})</span></td>`;
        }
    });

    // Attach sort listeners if not already attached
    const thead = table.querySelector('thead');
    thead.querySelectorAll('th[data-sort]').forEach(th => {
        if (!th.dataset.listenerAttached) {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                const newDir = (table.dataset.sortKey === key && table.dataset.sortDir === 'asc') ? 'desc' : 'asc';
                table.dataset.sortKey = key;
                table.dataset.sortDir = newDir; 
                populateKpiTable(dataMap, tableId, useCCCName, delayType); // Re-sort and re-populate THIS table
            });
            th.dataset.listenerAttached = 'true';
        }
    });

    // Update sort icons
    thead.querySelectorAll('th').forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        const icon = th.querySelector('.sort-icon');
        if (icon) icon.textContent = '';
        if (th.dataset.sort === sortKey) {
            th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
            if (icon) icon.textContent = sortDir === 'asc' ? '▲' : '▼';
        }
    });
}

// --- NEW: Functions for Breakdown Modal ---

function openBreakdownModal(title, delayType) {
    const modal = document.getElementById('breakdownModal');
    modal.style.display = 'block';

    // Clear existing table headers to allow for dynamic regeneration
    ['modalRegionTable', 'modalDivisionTable', 'modalCCCTable'].forEach(tableId => {
        const table = document.getElementById(tableId);
        const thead = table.querySelector('thead');
        if (thead) thead.remove();
    });

    // Populate tables inside the new modal
    const regionMap = {}, divisionMap = {}, cccMap = {};
    const dataToUse = filteredData.length > 0 ? filteredData : allData;

    dataToUse.forEach(d => {
        if (d.REGION) (regionMap[d.REGION] = regionMap[d.REGION] || []).push(d);
        if (d.DIVN_NAME) (divisionMap[d.DIVN_NAME] = divisionMap[d.DIVN_NAME] || []).push(d);
        if (d.CCC_CODE) (cccMap[d.CCC_CODE] = cccMap[d.CCC_CODE] || []).push(d);
    });

    // Populate tables with new IDs
    addTableHeaders('modalRegionTable', 'Region', delayType);
    addTableHeaders('modalDivisionTable', 'Division', delayType);
    addTableHeaders('modalCCCTable', 'CCC', delayType);

    // Set modal title
    const modalTitle = document.getElementById('breakdownModalTitle');
    if (modalTitle) {
        modalTitle.textContent = `${title} - Office-wise Breakdown`;
    }

    // Populate tables
    const level = getKpiSummaryLevel();
    applyKpiSummaryVisibility(level);
    populateKpiTable(regionMap, 'modalRegionTable', false, delayType);
    populateKpiTable(divisionMap, 'modalDivisionTable', false, delayType);
    populateKpiTable(cccMap, 'modalCCCTable', true, delayType);

    const tabName = defaultBreakdownTab(level);
    const tabBtn = document.querySelector('.tab-link[data-kpi-tab="' + (level === 'ccc' ? 'ccc' : (level === 'division' ? 'division' : 'region')) + '"]');
    openTab({ currentTarget: tabBtn || document.querySelector('.tab-link') }, tabName);
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

// Helper to dynamically add table headers if they don't exist
function addTableHeaders(tableId, nameHeader, delayType = null) {
    const table = document.getElementById(tableId);
    if (!table || table.querySelector('thead')) return; // Exit if no table or thead already exists

    const thead = table.createTHead();
    const row = thead.insertRow();
    row.innerHTML = delayType
        ? `<th data-sort="name">${nameHeader} <span class="sort-icon"></span></th>
           <th data-sort="${delayType}">Average Delay <span class="sort-icon"></span></th>`
        : `<th data-sort="name">${nameHeader} <span class="sort-icon"></span></th>
           <th data-sort="Qtn">Qtn Delay <span class="sort-icon"></span></th>
           <th data-sort="WO">WO Delay <span class="sort-icon"></span></th>
           <th data-sort="Conn">Conn Delay <span class="sort-icon"></span></th>`;
    if (!table.querySelector('tbody')) {
        table.createTBody();
    }
}


// --- UTILITY FUNCTIONS ---

function average(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

function getCCCName(cccCode) {
    const item = allData.find(d => d.CCC_CODE === cccCode);
    return item ? item.SUPP_OFF : cccCode;
}
