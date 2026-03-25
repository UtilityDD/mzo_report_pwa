const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSE7jMusI5YFc4fcuHMyWpbqGp1fIcWBNRYh6yieCY8yUyjOgC1ZRWB7flXE0DAVEbHUfG-KlzWCZyf/pub?gid=202809558&single=true&output=csv';

const searchInput = document.getElementById('search-input');
const chartHeader = document.getElementById('chart-header');
const storeFilter = document.getElementById('store-filter');
const materialGroupFilter = document.getElementById('material-group-filter');
const materialDescriptionFilter = document.getElementById('material-description-filter');
const downloadBtn = document.getElementById('download-btn');
const lowStockAlertBtn = document.getElementById('low-stock-alert-btn');

let allData = [];
let currentSortColumn = null;
let currentSortDirection = 'asc';
let currentStoreTab = 'total'; // 'total', 'old', 'new'
let currentFilteredData = []; 

const PLANT_MAP = {
    '3342': 'Malda (D) Division',
    '6611': 'Malda (D) Division',
    '3461': 'Balurghat (D) Division',
    '6631': 'Balurghat (D) Division',
    '3462': 'Buniadpur (D) Division',
    '6632': 'Buniadpur (D) Division',
    '3343': 'Chanchal (D) Division',
    '6612': 'Chanchal (D) Division',
    '6613': 'Gazole (D) Division',
    '3434': 'Islampur (D) Division',
    '6622': 'Islampur (D) Division',
    '6621': 'Raiganj (D) Division',
    '3432': 'Raiganj (D) Division',
    '6600': 'Malda (D) Zone',
    '7201': 'Malda (D) Zone'
};

function formatDate(dateString) {
    const date = new Date(dateString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

/**
 * Parses a string that represents a number and may contain commas.
 * @param {string | number} value The string or number to parse.
 * @returns {number} The parsed number. Returns 0 if parsing is not possible.
 */
function parseStockNumber(value) {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        // Remove commas from the string and then parse it as a float.
        const cleanedValue = value.replace(/,/g, '');
        return parseFloat(cleanedValue) || 0;
    }
    return 0;
}

function applyFilters() {
    let filteredData = [...allData];
    const searchTerm = searchInput.value.toLowerCase();
    const selectedStore = storeFilter.value;
    const selectedGroup = materialGroupFilter.value;
    const selectedDescription = materialDescriptionFilter.value;

    if (searchTerm) {
        filteredData = filteredData.filter(item =>
            (item['Material Description'] && item['Material Description'].toLowerCase().includes(searchTerm)) ||
            (item['Material'] && String(item['Material']).toLowerCase().includes(searchTerm))
        );
    }

    if (selectedStore) {
        filteredData = filteredData.filter(item => item.StoreName === selectedStore);
    }

    if (currentStoreTab === 'old') {
        filteredData = filteredData.filter(item => item.StoreType === 'old');
    } else if (currentStoreTab === 'new') {
        filteredData = filteredData.filter(item => item.StoreType === 'new');
    }

    if (selectedGroup) {
        filteredData = filteredData.filter(item => item['Material Group'] === selectedGroup);
    }

    if (selectedDescription) {
        filteredData = filteredData.filter(item => item['Material Description'] === selectedDescription);
    }

    // Update KPI cards with filtered data
    populateKpiCards(filteredData);
    
    populateTable(filteredData);
    
    // Store globally for modals to use
    currentFilteredData = filteredData;
}

function populateFilters(data) {
    const prevStore = storeFilter.value;
    const prevGroup = materialGroupFilter.value;
    const prevDesc = materialDescriptionFilter.value;

    const storeSel = storeFilter;
    while (storeSel.options.length > 1) storeSel.remove(1);

    // Get data relevant to current tab to find unique store names
    const currentTabData = data.filter(item => {
        if (currentStoreTab === 'old') return item.StoreType === 'old';
        if (currentStoreTab === 'new') return item.StoreType === 'new';
        return true;
    });

    const stores = [...new Set(currentTabData.map(item => item.StoreName))].sort();
    stores.forEach(store => {
        const option = document.createElement('option');
        option.value = store;
        option.textContent = store;
        storeSel.appendChild(option);
    });
    
    // Restore store if possible (Handles persistence across tabs seamlessly as all use Names)
    if (Array.from(storeSel.options).some(opt => opt.value === prevStore)) {
        storeSel.value = prevStore;
    } else if (PLANT_MAP[prevStore]) {
        // Transition Case: If the previous value was a specific Code (from earlier version), map it to Name
        const nameFromCode = PLANT_MAP[prevStore];
        if (Array.from(storeSel.options).some(opt => opt.value === nameFromCode)) {
            storeSel.value = nameFromCode;
        }
    }

    const groupSel = materialGroupFilter;
    while (groupSel.options.length > 1) groupSel.remove(1);
    const materialGroups = [...new Set(data.map(item => item['Material Group']))].sort();
    materialGroups.forEach(group => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        groupSel.appendChild(option);
    });
    if (Array.from(groupSel.options).some(opt => opt.value === prevGroup)) {
        groupSel.value = prevGroup;
    }

    const descSel = materialDescriptionFilter;
    while (descSel.options.length > 1) descSel.remove(1);
    const materialDescriptions = [...new Set(data.map(item => item['Material Description']))].sort();
    materialDescriptions.forEach(desc => {
        const option = document.createElement('option');
        option.value = desc;
        option.textContent = desc;
        descSel.appendChild(option);
    });
    if (Array.from(descSel.options).some(opt => opt.value === prevDesc)) {
        descSel.value = prevDesc;
    }
}

function updateDescriptionFilter() {
    const selectedStore = storeFilter.value;
    const selectedGroup = materialGroupFilter.value;
    const option = materialDescriptionFilter;

    // Get descriptions for selected store and group, respecting current tab
    let descriptions = [];
    let filteredItems = allData;

    // Filter by Tab
    if (currentStoreTab === 'old') {
        filteredItems = filteredItems.filter(item => item.StoreType === 'old');
    } else if (currentStoreTab === 'new') {
        filteredItems = filteredItems.filter(item => item.StoreType === 'new');
    }

    if (selectedStore) {
        filteredItems = filteredItems.filter(item => item.StoreName === selectedStore);
    }
    if (selectedGroup) {
        filteredItems = filteredItems.filter(item => item['Material Group'] === selectedGroup);
    }

    // Only populate descriptions if a group is selected
    if (selectedGroup) {
        descriptions = [...new Set(filteredItems.map(item => item['Material Description']))].sort();
    }

    // Clear options except placeholder
    while (option.options.length > 1) {
        option.remove(1);
    }

    // Reset to placeholder
    option.value = '';

    // Add filtered descriptions
    descriptions.forEach(desc => {
        const opt = document.createElement('option');
        opt.value = desc;
        opt.textContent = desc;
        option.appendChild(opt);
    });
}

function changeStoreTab(tab) {
    currentStoreTab = tab;
    
    // Update tab UI
    document.querySelectorAll('.tab-link').forEach(btn => btn.classList.remove('active'));
    if (tab === 'total') document.getElementById('btnTabTotal').classList.add('active');
    if (tab === 'new') document.getElementById('btnTabNew').classList.add('active');
    if (tab === 'old') document.getElementById('btnTabOld').classList.add('active');

    // Update table header for 1st column
    const ths = document.querySelectorAll('#data-table th');
    if (ths.length > 0) {
        ths[0].textContent = tab === 'total' ? 'Store Name' : 'Store Code';
    }

    populateFilters(allData);
    applyFilters();
}

function updateGroupFilter() {
    const selectedStore = storeFilter.value;
    const option = materialGroupFilter;

    // Get groups for selected store, respecting current tab
    let groups = [];
    let filteredItems = allData;

    // Filter by Tab
    if (currentStoreTab === 'old') {
        filteredItems = filteredItems.filter(item => item.StoreType === 'old');
    } else if (currentStoreTab === 'new') {
        filteredItems = filteredItems.filter(item => item.StoreType === 'new');
    }

    if (selectedStore) {
        filteredItems = filteredItems.filter(item => item.StoreName === selectedStore);
    }

    groups = [...new Set(filteredItems.map(item => item['Material Group']))].sort();

    // Clear options except placeholder
    while (option.options.length > 1) {
        option.remove(1);
    }

    // Reset to placeholder
    option.value = '';

    // Add filtered groups
    groups.forEach(group => {
        const opt = document.createElement('option');
        opt.value = group;
        opt.textContent = group;
        option.appendChild(opt);
    });

    // Reset description filter
    materialDescriptionFilter.value = '';
    updateDescriptionFilter();
}

function populateKpiCards(data) {
    const kpiContainer = document.getElementById('kpi-container');
    kpiContainer.innerHTML = ''; // Clear previous cards
    const materialGroupsForKpi = ['POLE', 'HBEAM', 'TRANSFORM', 'SMART_MET', 'CONDUCTOR'];

    materialGroupsForKpi.forEach(groupName => {
        let groupData = data.filter(item => item['Material Group'] === groupName);

        // Special condition for TRANSFORM group to only include items with "DTR"
        if (groupName === 'TRANSFORM') {
            groupData = groupData.filter(item =>
                item['Material Description'] && item['Material Description'].toUpperCase().includes('DTR')
            );
        }

        // Special condition for POLE group to exclude a specific item
        if (groupName === 'POLE') {
            groupData = groupData.filter(item =>
                item['Material Description']?.toUpperCase() !== 'RAIL POLE 11-13M (52KG.)'
            );
        }

        if (groupData.length > 0) {
            const totalStock = groupData.reduce((sum, item) => {
                return sum + parseStockNumber(item.Unrestricted);
            }, 0);

            const unit = groupData[0]['Base Unit of Measure'] || '';

            const card = document.createElement('div');
            card.className = 'kpi-card';
            const cardTitle = groupName === 'TRANSFORM' ? 'DTR' : groupName.replace('_', ' ');

            card.innerHTML = `
                <h3 class="kpi-title">${cardTitle}</h3>
                <p class="kpi-value">
                    ${totalStock.toLocaleString(undefined, { maximumFractionDigits: 2 })}<span class="kpi-unit">${unit}</span>
                </p>
            `;
            // Add click event to open modal
            card.addEventListener('click', () => showBreakdownModal(groupName));
            kpiContainer.appendChild(card);
        }
    });
}

function showBreakdownModal(groupName) {
    const modal = document.getElementById('breakdown-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalTableBody = document.getElementById('modal-table-body');

    const modalHeaderTitle = groupName === 'TRANSFORM' ? 'DTR' : groupName.replace('_', ' ');
    // Set title and clear previous data
    modalTitle.textContent = `${modalHeaderTitle} Stock Details`;
    modalTableBody.innerHTML = '';

    // Filter data for the selected group from current filtered set
    let groupData = currentFilteredData.filter(item => item['Material Group'] === groupName);

    // Apply the same special condition for the TRANSFORM modal breakdown
    if (groupName === 'TRANSFORM') {
        groupData = groupData.filter(item =>
            item['Material Description'] && item['Material Description'].toUpperCase().includes('DTR')
        );
    }

    // Apply the same special condition for the POLE modal breakdown
    if (groupName === 'POLE') {
        groupData = groupData.filter(item =>
            item['Material Description']?.toUpperCase() !== 'RAIL POLE 11-13M (52KG.)'
        );
    }

    // Group and sum data (similar to main table logic)
    const storeData = {};
    groupData.forEach(item => {
        const key = `${item.StoreName}|${item['Material']}|${item['Material Description']}`;
        if (!storeData[key]) {
            storeData[key] = {
                store: item.StoreName,
                materialCode: item['Material'],
                material: item['Material Description'],
                stock: 0,
                unit: item['Base Unit of Measure'] || ''
            };
        }
        storeData[key].stock += parseStockNumber(item.Unrestricted);
    });

    const sortedData = Object.values(storeData).sort((a, b) => {
        const aIsZone = String(a.store).toLowerCase().includes('zone');
        const bIsZone = String(b.store).toLowerCase().includes('zone');

        if (aIsZone && !bIsZone) return -1;
        if (!aIsZone && bIsZone) return 1;

        return a.store.localeCompare(b.store) || a.material.localeCompare(b.material);
    });

    // Populate modal table with store-wise subtotals
    let currentStore = null;
    let storeSubtotal = 0;

    sortedData.forEach(item => {
        // Do not show rows with zero stock
        if (item.stock === 0) {
            return; // Skip to the next item
        }

        // If we are entering a new store group (and it's not the very first item)
        if (currentStore !== null && item.store !== currentStore) {
            // Add the subtotal row for the previous store
            const subtotalRow = modalTableBody.insertRow();
            subtotalRow.className = 'store-subtotal-row';
            subtotalRow.innerHTML = `
                <td colspan="3" style="text-align: right; font-weight: 600;">Total for ${currentStore}:</td>
                <td style="text-align: right; font-weight: 600;">${storeSubtotal.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                <td>${item.unit}</td>
            `;
            storeSubtotal = 0; // Reset subtotal for the new store
        }

        // Set/update the current store
        currentStore = item.store;

        // Add the regular item row
        const row = modalTableBody.insertRow();
        if (item.store.toLowerCase().includes('zone')) {
            row.className = 'zonal-row';
        }
        row.innerHTML = `
            <td>${item.store}</td>
            <td>${item.materialCode}</td>
            <td>${item.material}</td>
            <td style="text-align: right;">${item.stock.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
            <td>${item.unit}</td>
        `;
        storeSubtotal += item.stock; // Add current item's stock to the subtotal
    });

    // After the loop, add the final subtotal row if there's any data
    if (currentStore !== null) {
        const subtotalRow = modalTableBody.insertRow();
        subtotalRow.className = 'store-subtotal-row';
        subtotalRow.innerHTML = `
            <td colspan="3" style="text-align: right; font-weight: 600;">Total for ${currentStore}:</td>
            <td style="text-align: right; font-weight: 600;">${storeSubtotal.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
            <td>${sortedData[sortedData.length - 1].unit}</td>
        `;
    }

    // Show the modal
    modal.style.display = 'block';
}

function showLowStockModal() {
    const modal = document.getElementById('low-stock-modal');
    const contentContainer = document.getElementById('low-stock-content');
    const modalSubtitle = document.querySelector('#low-stock-modal .modal-subtitle');
    contentContainer.innerHTML = ''; // Clear previous content

    // First, aggregate stock data from current filtered set
    const aggregatedStock = {};
    currentFilteredData.forEach(item => {
        const key = `${item.StoreName}|${item['Material']}|${item['Material Description']}`;
        if (!aggregatedStock[key]) {
            aggregatedStock[key] = {
                store: item.StoreName,
                material: item['Material Description'],
                stock: 0,
                group: item['Material Group'] // Keep track of the group
            };
        }
        aggregatedStock[key].stock += parseStockNumber(item.Unrestricted);
    });

    // Filter for items that are critically low based on group-specific thresholds
    const lowStockItems = Object.values(aggregatedStock).filter(item => {
        if (item.stock <= 0) return false; // Always exclude zero or negative stock

        switch (item.group) {
            case 'CONDUCTOR':
                return item.stock < 10;
            case 'SMART_MET':
                return item.stock === 10;
            case 'METER':
                return item.stock < 100;
            case 'MSANGLE':
            case 'MSCHANNEL':
            case 'MSFLAT':
                return item.stock === 1;
            default:
                return item.stock <= 10; // Default threshold for other groups
        }
    });

    if (lowStockItems.length === 0) {
        modalSubtitle.textContent = 'All stock levels are healthy.';
        contentContainer.innerHTML = '<p style="text-align: center; color: #155724; background: #d4edda; padding: 15px; border-radius: 6px;">Good news! No critically low stock items found.</p>';
    } else {
        // Group low stock items by store
        const itemsByStore = lowStockItems.reduce((acc, item) => {
            if (!acc[item.store]) {
                acc[item.store] = [];
            }
            acc[item.store].push(item);
            return acc;
        }, {});

        // Create a card for each store, sorted with Zone at the top
        const sortedStores = Object.keys(itemsByStore).sort((a, b) => {
            const aIsZone = String(a).toLowerCase().includes('zone');
            const bIsZone = String(b).toLowerCase().includes('zone');

            if (aIsZone && !bIsZone) return -1;
            if (!aIsZone && bIsZone) return 1;

            return a.localeCompare(b);
        });

        sortedStores.forEach(store => {
            const storeCard = document.createElement('div');
            storeCard.className = 'low-stock-store-card';
            if (store.toLowerCase().includes('zone')) {
                storeCard.classList.add('zonal-row');
            }

            let itemsHTML = itemsByStore[store]
                .map(item => `<div class="low-stock-item"><span>${item.material}</span><strong>${item.stock}</strong></div>`)
                .join('');

            storeCard.innerHTML = `
                <h3 class="low-stock-store-title">${store}</h3>
                ${itemsHTML}
            `;
            contentContainer.appendChild(storeCard);
        });
    }

    modal.style.display = 'block';
}

function animatePlaceholder() {
    const text = "Search with Material Name or Material Code...";
    let i = 0;
    let currentText = '';
    let isDeleting = false;
    let cursorVisible = true;

    function type() {
        let timeout = 80; // Default typing speed

        if (isDeleting) {
            // Deleting text
            i--;
            currentText = text.substring(0, i);
            timeout = 50;
            if (i === 0) {
                isDeleting = false;
                timeout = 500; // Pause before re-typing
            }
        } else {
            // Typing text
            i++;
            currentText = text.substring(0, i);
            if (i === text.length) {
                isDeleting = true;
                timeout = 2000; // Pause at the end
            }
        }

        // Alternate the cursor visibility
        cursorVisible = !cursorVisible;
        searchInput.placeholder = currentText + (cursorVisible ? '|' : '');

        setTimeout(type, timeout);
    }

    // When the user starts typing, remove the animation class
    searchInput.addEventListener('focus', () => {
        // Stop the animation and set the final placeholder text
        clearTimeout(0); // This is a trick to clear the pending timeout
        searchInput.placeholder = text;
    });

    type();
}

// Initialize
async function initDashboard() {
    try {
        let cachedData;
        if (typeof mzoDataHub !== 'undefined') {
            cachedData = await mzoDataHub.get('CACHE_STOCK');
        }

        if (cachedData) {
            console.log("Successfully fetched Stock Data from DataHub.");
            const results = Papa.parse(cachedData, {
                header: true,
                skipEmptyLines: true
            });
            handleResults(results.data);
        } else {
            console.log("Downloading Stock Data from network...");
            fetchFromNetwork();
        }
    } catch (e) {
        console.error("DataHub fetch failed, falling back to network.", e);
        fetchFromNetwork();
    }
}

function handleResults(data) {
    // Handle potential parsing errors or empty rows from Google Sheets
    allData = data.map(item => {
        const plant = String(item.Plant || "").trim();
        let storeName = PLANT_MAP[plant] || item.Store || item['Name 1'] || 'Unknown';
        
        let type = 'unknown';
        if (plant.startsWith('3')) type = 'old';
        if (plant.startsWith('6')) type = 'new';

        return {
            ...item,
            StoreName: storeName,
            StoreType: type,
            Plant: plant
        };
    }).filter(item => item.StoreName && item['Material Group']);

    // Separate Malda and Zone if they are clubbed
    allData.forEach(item => {
        if (item.StoreName === 'Malda & Zone') {
            if (item.Plant === '6611') item.StoreName = 'Malda';
            else if (item.Plant === '7201') item.StoreName = 'Zone';
        }
    });

    const latestDate = allData.reduce((max, item) => item.Date > max ? item.Date : max, '');
    chartHeader.textContent = `Stock of Major Materials (${formatDate(latestDate)})`;

    // Populate the new KPI cards and initial filtered data
    currentFilteredData = [...allData];
    populateKpiCards(allData);

    // Start placeholder animation
    animatePlaceholder();

    populateFilters(allData);
    populateTable(allData);

    storeFilter.addEventListener('change', function () {
        updateGroupFilter();
        applyFilters();
    });
    materialGroupFilter.addEventListener('change', function () {
        updateDescriptionFilter();
        applyFilters();
    });
    materialDescriptionFilter.addEventListener('change', applyFilters);
    searchInput.addEventListener('input', applyFilters);
    lowStockAlertBtn.addEventListener('click', showLowStockModal);

    // Modal close functionality
    const modal = document.getElementById('breakdown-modal');
    const modalCloseBtn = document.querySelector('.modal-close');
    modalCloseBtn.onclick = function () {
        modal.style.display = 'none';
    }
    window.onclick = function (event) {
        if (event.target == modal) {
            modal.style.display = 'none';
        }
    }

    // Low Stock Modal close functionality
    const lowStockModal = document.getElementById('low-stock-modal');
    const lowStockModalCloseBtn = document.querySelector('.modal-close-low-stock');
    lowStockModalCloseBtn.onclick = function () {
        lowStockModal.style.display = 'none';
    }
    window.addEventListener('click', function (event) {
        if (event.target == lowStockModal) {
            lowStockModal.style.display = 'none';
        }
    });

    // Add sorting to table headers
    document.querySelectorAll('#data-table th').forEach((th, index) => {
        th.addEventListener('click', function () {
            // Toggle sort direction
            if (currentSortColumn === index) {
                currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                currentSortColumn = index;
                currentSortDirection = 'asc';
            }

            // Update header styles
            document.querySelectorAll('#data-table th').forEach(header => {
                header.classList.remove('sort-asc', 'sort-desc');
            });
            if (currentSortDirection === 'asc') {
                th.classList.add('sort-asc');
            } else {
                th.classList.add('sort-desc');
            }

            // Re-render table
            applyFilters();
        });
    });

    // Download CSV functionality
    downloadBtn.addEventListener('click', downloadTableAsCSV);
}

function fetchFromNetwork() {
    Papa.parse(DATA_URL, {
        download: true,
        header: true,
        complete: function (results) {
            handleResults(results.data);
        },
        error: function (error) {
            console.error('Error loading data from network:', error);
            // Hide loader and show error if needed
            document.querySelector('.loader-cell').innerHTML = '<div class="no-data-message">Failed to load data from network.</div>';
        }
    });
}

initDashboard();

function downloadTableAsCSV() {
    const table = document.getElementById('data-table');
    let csv = [];

    // Add headers
    const headers = [];
    document.querySelectorAll('#data-table th').forEach(th => {
        const text = th.textContent.replace(/\s*[↑↓↕]\s*$/, '').trim();
        if (text) { // Avoid adding empty headers if any
            headers.push(`"${text}"`);
        }
    });
    csv.push(headers.join(','));

    // Add data rows (excluding total row)
    document.querySelectorAll('#data-table tbody tr:not(.total-row)').forEach(tr => {
        const row = [];
        tr.querySelectorAll('td').forEach(td => {
            row.push(`"${td.textContent.trim()}"`);
        });
        csv.push(row.join(','));
    });

    // Add total row
    const totalRow = [];
    document.querySelector('#data-table tbody tr.total-row').querySelectorAll('td').forEach(td => {
        totalRow.push(`"${td.textContent.trim()}"`);
    });
    csv.push(totalRow.join(','));

    // Create blob and download
    const csvContent = csv.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', `stock-data-${timestamp}.csv`);
    link.style.visibility = 'hidden';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function populateTable(data) {
    const tableBody = document.querySelector('#data-table tbody');
    tableBody.innerHTML = '';

    // Group data by store and material description
    const storeData = {};
    data.forEach(item => {
        const displayStore = currentStoreTab === 'total' ? item.StoreName : `${item.Plant} (${item.StoreName})`;
        const key = `${displayStore}|${item['Material']}|${item['Material Description']}`;
        if (!storeData[key]) {
            storeData[key] = {
                store: displayStore,
                materialCode: item['Material'],
                material: item['Material Description'],
                stock: 0,
                unit: item['Base Unit of Measure'] || ''
            };
        }
        storeData[key].stock += parseStockNumber(item.Unrestricted);
    });

    // Sort by store name and material, but prioritize "Zone"
    let sortedData = Object.values(storeData)
        .sort((a, b) => {
            const aIsZone = String(a.store).toLowerCase().includes('zone');
            const bIsZone = String(b.store).toLowerCase().includes('zone');

            if (aIsZone && !bIsZone) return -1;
            if (!aIsZone && bIsZone) return 1;

            if (a.store !== b.store) {
                return a.store.localeCompare(b.store);
            }
            return a.material.localeCompare(b.material);
        });

    // Apply current sort if any
    if (currentSortColumn) {
        sortedData = sortData(sortedData, currentSortColumn, currentSortDirection);
    }

    const searchTerm = searchInput.value.trim();
    let regex;
    if (searchTerm) {
        // Escape special characters for regex and create a case-insensitive, global regex
        const escapedTerm = searchTerm.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        regex = new RegExp(escapedTerm, 'gi');
    }

    let totalStock = 0;
    let rowsAdded = 0;
    sortedData.forEach(item => {
        // Do not show rows with zero stock
        if (item.stock === 0) {
            return; // Skip to the next item
        }

        const row = document.createElement('tr');
        if (item.store.toLowerCase().includes('zone')) {
            row.className = 'zonal-row';
        }

        // Highlight search term if it exists
        const materialCodeHTML = searchTerm ? String(item.materialCode).replace(regex, match => `<mark class="highlight">${match}</mark>`) : item.materialCode;
        const materialDescHTML = searchTerm ? item.material.replace(regex, match => `<mark class="highlight">${match}</mark>`) : item.material;

        row.innerHTML = `
            <td>${item.store}</td>
            <td>${materialCodeHTML}</td>
            <td>${materialDescHTML}</td>
            <td style="text-align: right;">${item.stock.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</td>
            <td>${item.unit}</td>
        `;
        tableBody.appendChild(row);
        totalStock += item.stock;
        rowsAdded++;
    });

    if (rowsAdded > 0) {
        // Add total row only if there are items
        const totalRow = document.createElement('tr');
        totalRow.className = 'total-row';
        totalRow.innerHTML = `
            <td colspan="3"></td>
            <td style="text-align: right; font-weight: 600;">Total:</td>
            <td style="font-weight: 600; text-align: right;">${totalStock.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</td>
            <td></td>
        `;
        tableBody.appendChild(totalRow);
    } else {
        // Show a message if no data is found
        const messageRow = document.createElement('tr');
        const messageCell = document.createElement('td');
        messageCell.colSpan = 5;
        messageCell.className = 'no-data-message';

        const searchTerm = searchInput.value.trim();
        const selectedStore = storeFilter.value;

        if (searchTerm) {
            messageCell.textContent = selectedStore ? `No stock found for "${searchTerm}" in store "${selectedStore}".` : `No stock found for "${searchTerm}" in any store.`;
        } else {
            messageCell.textContent = 'No stock available for the selected filters.';
        }
        messageRow.appendChild(messageCell);
        tableBody.appendChild(messageRow);
    }
}

function sortData(data, column, direction) {
    const sorted = [...data];
    sorted.sort((a, b) => {
        const aIsZone = String(a.store).toLowerCase().includes('zone');
        const bIsZone = String(b.store).toLowerCase().includes('zone');

        // Always keep Zone at the top
        if (aIsZone && !bIsZone) return -1;
        if (!aIsZone && bIsZone) return 1;

        let aVal, bVal;
        switch (column) {
            case 0:
                aVal = a.store;
                bVal = b.store;
                break;
            case 1:
                aVal = a.materialCode;
                bVal = b.materialCode;
                break;
            case 2:
                aVal = a.material;
                bVal = b.material;
                break;
            case 3:
                aVal = a.stock;
                bVal = b.stock;
                break;
            case 4:
                aVal = a.unit;
                bVal = b.unit;
                break;
            default:
                return 0;
        }

        // Handle numeric or string-based material codes
        if (column === 1) {
            const res = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
            return direction === 'asc' ? res : -res;
        } else if (typeof aVal === 'string') {
            const res = aVal.toLowerCase().localeCompare(bVal.toLowerCase());
            return direction === 'asc' ? res : -res;
        } else {
            return direction === 'asc' ? aVal - bVal : bVal - aVal;
        }
    });
    return sorted;
}
