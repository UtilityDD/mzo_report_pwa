const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSE7jMusI5YFc4fcuHMyWpbqGp1fIcWBNRYh6yieCY8yUyjOgC1ZRWB7flXE0DAVEbHUfG-KlzWCZyf/pub?gid=202809558&single=true&output=csv';

const chartHeader = document.getElementById('chart-header');
const materialGroupFilter = document.getElementById('material-group-filter');
const materialDescriptionFilter = document.getElementById('material-description-filter');
const downloadBtn = document.getElementById('download-btn');

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

function applyFilters() {
    let filteredData = [...allData];
    const selectedGroup = materialGroupFilter.value;
    const selectedDescription = materialDescriptionFilter.value;

    if (selectedGroup) {
        filteredData = filteredData.filter(item => item['Material Group'] === selectedGroup);
    }

    if (selectedDescription) {
        filteredData = filteredData.filter(item => item['Material Description'] === selectedDescription);
    }

    populateTable(filteredData);
}

function populateFilters(data) {
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
    const selectedGroup = materialGroupFilter.value;
    const option = materialDescriptionFilter;
    
    // Get descriptions for selected group
    let descriptions = [];
    if (selectedGroup) {
        descriptions = [...new Set(
            allData
                .filter(item => item['Material Group'] === selectedGroup)
                .map(item => item['Material Description'])
        )].sort();
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

Papa.parse(DATA_URL, {
    download: true,
    header: true,
    complete: function(results) {
        allData = results.data;
        const latestDate = allData.reduce((max, item) => item.Date > max ? item.Date : max, '');
        chartHeader.textContent = `Stock of materials (${formatDate(latestDate)})`;

        populateFilters(allData);
        populateTable(allData);

        materialGroupFilter.addEventListener('change', function() {
            updateDescriptionFilter();
            applyFilters();
        });
        materialDescriptionFilter.addEventListener('change', applyFilters);

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
        headers.push(`"${text}"`);
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
        const key = `${item.Store}|${item['Material Description']}`;
        if (!storeData[key]) {
            storeData[key] = {
                store: item.Store,
                material: item['Material Description'],
                stock: 0,
                unit: item['Base Unit of Measure'] || ''
            };
        }
        storeData[key].stock += parseFloat(item.Unrestricted || 0);
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

    let totalStock = 0;
    sortedData.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.store}</td>
            <td>${item.material}</td>
            <td>${item.stock}</td>
            <td>${item.unit}</td>
        `;
        tableBody.appendChild(row);
        totalStock += item.stock;
    });

    // Add total row
    const totalRow = document.createElement('tr');
    totalRow.className = 'total-row';
    totalRow.innerHTML = `
        <td></td>
        <td style="text-align: right; font-weight: 600;">Total:</td>
        <td style="font-weight: 600;">${parseFloat(totalStock.toFixed(3))}</td>
        <td></td>
    `;
    tableBody.appendChild(totalRow);
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
                aVal = a.material;
                bVal = b.material;
                break;
            case 2:
                aVal = parseFloat(a.stock);
                bVal = parseFloat(b.stock);
                break;
            case 3:
                aVal = a.unit;
                bVal = b.unit;
                break;
            default:
                return 0;
        }

        if (typeof aVal === 'string') {
            aVal = aVal.toLowerCase();
            bVal = bVal.toLowerCase();
            return direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        } else {
            return direction === 'asc' ? aVal - bVal : bVal - aVal;
        }
    });
    return sorted;
}
