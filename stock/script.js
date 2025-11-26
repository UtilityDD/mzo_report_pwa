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
        filteredData = filteredData.filter(item => item.Store === selectedStore);
    }

    if (selectedGroup) {
        filteredData = filteredData.filter(item => item['Material Group'] === selectedGroup);
    }

    if (selectedDescription) {
        filteredData = filteredData.filter(item => item['Material Description'] === selectedDescription);
    }

    populateTable(filteredData);
}

function populateFilters(data) {
    const stores = [...new Set(data.map(item => item.Store))].sort();
    stores.forEach(store => {
        const option = document.createElement('option');
        option.value = store;
        option.textContent = store;
        storeFilter.appendChild(option);
    });

    const materialGroups = [...new Set(data.map(item => item['Material Group']))];
    materialGroups.forEach(group => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        materialGroupFilter.appendChild(option);
    });

    const materialDescriptions = [...new Set(data.map(item => item['Material Description']))];
    materialDescriptions.forEach(desc => {
        const option = document.createElement('option');
        option.value = desc;
        option.textContent = desc;
        materialDescriptionFilter.appendChild(option);
    });
}

function updateDescriptionFilter() {
    const selectedStore = storeFilter.value;
    const selectedGroup = materialGroupFilter.value;
    const option = materialDescriptionFilter;
    
    // Get descriptions for selected store and group
    let descriptions = [];
    let filteredItems = allData;

    if (selectedStore) {
        filteredItems = filteredItems.filter(item => item.Store === selectedStore);
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

function updateGroupFilter() {
    const selectedStore = storeFilter.value;
    const option = materialGroupFilter;
    
    // Get groups for selected store
    let groups = [];
    if (selectedStore) {
        groups = [...new Set(
            allData
                .filter(item => item.Store === selectedStore) // Keep filtering by store if one is selected
                .map(item => item['Material Group'])
        )].sort();
    } else {
        // If no store is selected, do not clear the groups.
        return;
    }
    
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

    // Filter data for the selected group
    let groupData = allData.filter(item => item['Material Group'] === groupName);

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
        const key = `${item.Store}|${item['Material']}|${item['Material Description']}`;
        if (!storeData[key]) {
            storeData[key] = {
                store: item.Store,
                materialCode: item['Material'],
                material: item['Material Description'],
                stock: 0,
                unit: item['Base Unit of Measure'] || ''
            };
        }
        storeData[key].stock += parseStockNumber(item.Unrestricted);
    });

    const sortedData = Object.values(storeData).sort((a, b) => a.store.localeCompare(b.store) || a.material.localeCompare(b.material));

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

    // First, aggregate all stock data
    const aggregatedStock = {};
    allData.forEach(item => {
        const key = `${item.Store}|${item['Material']}|${item['Material Description']}`;
        if (!aggregatedStock[key]) {
            aggregatedStock[key] = {
                store: item.Store,
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

        modalSubtitle.textContent = 'Showing items based on group-specific low stock rules.';

        // Create a card for each store
        for (const store in itemsByStore) {
            const storeCard = document.createElement('div');
            storeCard.className = 'low-stock-store-card';

            let itemsHTML = itemsByStore[store]
                .map(item => `<div class="low-stock-item"><span>${item.material}</span><strong>${item.stock}</strong></div>`)
                .join('');

            storeCard.innerHTML = `
                <h3 class="low-stock-store-title">${store}</h3>
                ${itemsHTML}
            `;
            contentContainer.appendChild(storeCard);
        }
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

Papa.parse(DATA_URL, {
    download: true,
    header: true,
    complete: function(results) {
        allData = results.data;

        // Handle potential parsing errors or empty rows from Google Sheets
        allData = allData.filter(item => item.Store && item['Material Group']);

        const latestDate = allData.reduce((max, item) => item.Date > max ? item.Date : max, '');
        chartHeader.textContent = `Stock of Major Materials (${formatDate(latestDate)})`;

        // Populate the new KPI cards
        populateKpiCards(allData);

        // Start placeholder animation
        animatePlaceholder();

        populateFilters(allData);
        populateTable(allData);

        storeFilter.addEventListener('change', function() {
            updateGroupFilter();
            applyFilters();
        });
        materialGroupFilter.addEventListener('change', function() {
            updateDescriptionFilter();
            applyFilters();
        });
        materialDescriptionFilter.addEventListener('change', applyFilters);
        searchInput.addEventListener('input', applyFilters);
        lowStockAlertBtn.addEventListener('click', showLowStockModal);

        // Modal close functionality
        const modal = document.getElementById('breakdown-modal');
        const modalCloseBtn = document.querySelector('.modal-close');
        modalCloseBtn.onclick = function() {
            modal.style.display = 'none';
        }
        window.onclick = function(event) {
            if (event.target == modal) {
                modal.style.display = 'none';
            }
        }

        // Low Stock Modal close functionality
        const lowStockModal = document.getElementById('low-stock-modal');
        const lowStockModalCloseBtn = document.querySelector('.modal-close-low-stock');
        lowStockModalCloseBtn.onclick = function() {
            lowStockModal.style.display = 'none';
        }
        window.addEventListener('click', function(event) {
            if (event.target == lowStockModal) {
                lowStockModal.style.display = 'none';
            }
        });

        // Add sorting to table headers
        document.querySelectorAll('#data-table th').forEach((th, index) => {
            th.addEventListener('click', function() {
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
});

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
        const key = `${item.Store}|${item['Material']}|${item['Material Description']}`;
        if (!storeData[key]) {
            storeData[key] = {
                store: item.Store,
                materialCode: item['Material'],
                material: item['Material Description'],
                stock: 0,
                unit: item['Base Unit of Measure'] || ''
            };
        }
        storeData[key].stock += parseStockNumber(item.Unrestricted);
    });

    // Sort by store name and material
    let sortedData = Object.values(storeData)
        .sort((a, b) => {
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
        let aVal, bVal;
        
        switch(column) {
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
            return direction === 'asc' ? String(aVal).localeCompare(String(bVal), undefined, { numeric: true }) : String(bVal).localeCompare(String(aVal), undefined, { numeric: true });
        } else if (typeof aVal === 'string') {
            aVal = aVal.toLowerCase();
            bVal = bVal.toLowerCase();
            return direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        } else {
            return direction === 'asc' ? aVal - bVal : bVal - aVal;
        }
    });
    return sorted;
}
