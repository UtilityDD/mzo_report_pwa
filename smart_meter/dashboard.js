// Data URLs
const DATA_URLS = {
    meterData: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSWjwUI4EUgEABlcggpdOS-WSPKY8my-5T0cLxT4h8tNz_IreQy6jUYKBnB5yc0n-fcs8FpVbwo6Qay/pub?gid=327926255&single=true&output=tsv',
    workOrderData: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSWjwUI4EUgEABlcggpdOS-WSPKY8my-5T0cLxT4h8tNz_IreQy6jUYKBnB5yc0n-fcs8FpVbwo6Qay/pub?gid=958431052&single=true&output=tsv'
};

// Hierarchical structure
const HIER = {
    "6610000": {
        name: "MALDA REGION", divisions: {
            "6611000": { name: "MALDA DIVISION", cccs: { "6611101": "MANIKCHAK", "6611102": "GOLAPGANJ", "6611103": "BAISHNABNAGAR", "6611104": "KALIACHAK", "6611105": "MOTHABARI", "6611106": "SUJAPUR", "6611107": "RATHBARI", "6611108": "FULBARI", "6611109": "MOKDUMPUR" } },
            "6612000": { name: "CHANCHAL DIVISION", cccs: { "6612101": "BHALUKA", "6612102": "SAMSI", "6612103": "PARANPUR", "6612104": "CHANCHAL", "6612105": "MALATIPUR", "6612106": "HARISHCHANDRAPUR", "6612107": "KUSHIDA" } },
            "6613000": { name: "GAZOLE DIVISION", cccs: { "6613101": "GAZOL", "6613102": "AIHO", "6613103": "PANDUA", "6613104": "BAMONGOLA", "6613105": "OLD MALDA" } }
        }
    },
    "6620000": {
        name: "UTTAR DINAJPUR REGION", divisions: {
            "6621000": { name: "RAIGANJ DIVISION", cccs: { "6621101": "ITAHAR", "6621102": "HEMTABAD", "6621103": "KALIYAGANJ", "6621104": "RAIGANJ", "6621105": "BIRNAGAR", "6621106": "KARANDIGHI" } },
            "6622000": { name: "ISLAMPUR DIVISION", cccs: { "6622101": "ISLAMPUR", "6622102": "CHOPRA", "6622103": "DALKHOLA", "6622104": "GOALPOKHER", "6622105": "KANKI" } }
        }
    },
    "6630000": {
        name: "DAKSHIN DINAJPUR REGION", divisions: {
            "6631000": { name: "BALURGHAT DIVISION", cccs: { "6631101": "BALURGHAT", "6631102": "TAPAN", "6631103": "KUMARGANJ", "6631104": "HILI", "6631105": "PATIRAM" } },
            "6632000": { name: "BUNIADPUR DIVISION", cccs: { "6632101": "BUNIADPUR", "6632102": "KUSMANDI", "6632103": "HARIRAMPUR", "6632104": "GANGARAMPUR" } }
        }
    }
};

// Global state
let meterDataRaw = [];
let workOrderDataRaw = [];
let currentFilters = {
    meterType: 'all',
    lot: 'all',
    region: 'all',
    division: 'all',
    ccc: 'all'
};
let sortConfig = {
    column: null,
    direction: 'asc'
};

// Initialize app
document.addEventListener('DOMContentLoaded', init);

async function init() {
    setupEventListeners();
    await loadData();
}

function setupEventListeners() {
    document.getElementById('meterTypeFilter').addEventListener('change', handleFilterChange);
    document.getElementById('lotFilter').addEventListener('change', handleFilterChange);
    document.getElementById('regionFilter').addEventListener('change', handleFilterChange);
    document.getElementById('divisionFilter').addEventListener('change', handleFilterChange);
    document.getElementById('cccFilter').addEventListener('change', handleFilterChange);
    document.getElementById('refreshBtn').addEventListener('click', refreshData);
    document.getElementById('exportBtn').addEventListener('click', exportToCSV);

    // Sortable columns
    document.querySelectorAll('.sortable').forEach(th => {
        th.addEventListener('click', () => handleSort(th.dataset.column));
    });

    // Event delegation for expandable rows
    document.getElementById('dataTable').addEventListener('click', handleRowClick);

    // Modal close button
    document.getElementById('modalCloseBtn').addEventListener('click', () => showModal(false));
    document.getElementById('detailModal').addEventListener('click', (e) => { if (e.target.id === 'detailModal') showModal(false); });
}

async function loadData() {
    showLoading(true);
    try {
        const [meterData, woData] = await Promise.all([
            fetchTSVData(DATA_URLS.meterData),
            fetchTSVData(DATA_URLS.workOrderData)
        ]);

        meterDataRaw = meterData;
        workOrderDataRaw = woData;

        populateFilterOptions();
        updateDashboard();
        updateDashboardDate(woData);

    } catch (error) {
        console.error('Error loading data:', error);
        alert('Failed to load data. Please check your internet connection and try again.');
    } finally {
        showLoading(false);
    }
}

function updateDashboardDate(data) {
    const dateElement = document.getElementById('dashboardDate');
    if (!dateElement) return;

    // Find the first row with a valid date in the 'Date' column
    const dateRow = data.find(row => row.Date && row.Date instanceof Date);
    if (!dateRow) {
        dateElement.textContent = '';
        return;
    }

    const dateObj = dateRow.Date;
    // Format the date to 'dd Mon, yyyy'
    const formattedDate = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/ /g, ' ');
    dateElement.textContent = `(${formattedDate.replace(/ (\d{4})$/, ', $1')})`;
}

async function fetchTSVData(url) {
    const response = await fetch(url);
    const text = await response.text();
    return parseTSV(text);
}

function parseTSV(tsvText) {
    const lines = tsvText.trim().split('\n');
    const headers = lines[0].split('\t').map(h => h.trim());

    return lines.slice(1).map(line => {
        const values = line.split('\t');
        const obj = {};
        headers.forEach((header, i) => {
            obj[header] = values[i] ? values[i].trim() : '';
            // If a column is named 'Date' and has a value, parse it into a Date object
            if (header === 'Date' && obj[header]) {
                const dateString = obj[header];
                const parts = dateString.split('/'); // Assuming dd/mm/yyyy format
                if (parts.length === 3) {
                    // Construct date in YYYY-MM-DD format for reliable Date object creation
                    const dateObj = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                    // Check for valid date, otherwise keep as original string or null
                    obj[header] = isNaN(dateObj.getTime()) ? dateString : dateObj;
                } else {
                    // If format is not dd/mm/yyyy, keep as original string
                    obj[header] = dateString;
                }
            }
        });
        return obj;
    });
}

function populateFilterOptions() {
    // Populate meter types
    const meterTypes = [...new Set(meterDataRaw.map(row => row.meter_type).filter(Boolean))];
    const meterTypeSelect = document.getElementById('meterTypeFilter');
    meterTypeSelect.innerHTML = '<option value="all">All Types</option>';
    meterTypes.forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        meterTypeSelect.appendChild(option);
    });

    // Populate lots
    const lots = [...new Set(meterDataRaw.map(row => row.Lot).filter(Boolean))];
    const lotSelect = document.getElementById('lotFilter');
    lotSelect.innerHTML = '<option value="all">All Lots</option>';
    lots.forEach(lot => {
        const option = document.createElement('option');
        option.value = lot;
        option.textContent = lot;
        lotSelect.appendChild(option);
    });

    // Populate Regions
    const regionSelect = document.getElementById('regionFilter');
    regionSelect.innerHTML = '<option value="all">All Regions</option>';
    Object.keys(HIER).forEach(regionCode => {
        const option = document.createElement('option');
        option.value = regionCode;
        option.textContent = HIER[regionCode].name;
        regionSelect.appendChild(option);
    });
}

function handleFilterChange(e) {
    const filterId = e.target.id;
    if (filterId === 'meterTypeFilter') currentFilters.meterType = e.target.value;
    if (filterId === 'lotFilter') currentFilters.lot = e.target.value;
    if (filterId === 'regionFilter') {
        currentFilters.region = e.target.value;
        currentFilters.division = 'all'; // Reset child filters
        currentFilters.ccc = 'all';
        populateDivisionFilter();
        populateCccFilter();
    }
    if (filterId === 'divisionFilter') {
        currentFilters.division = e.target.value;
        currentFilters.ccc = 'all'; // Reset child filter
        populateCccFilter();
    }
    if (filterId === 'cccFilter') currentFilters.ccc = e.target.value;

    updateDashboard();
}

function populateDivisionFilter() {
    const divisionSelect = document.getElementById('divisionFilter');
    divisionSelect.innerHTML = '<option value="all">All Divisions</option>';

    if (currentFilters.region === 'all') {
        divisionSelect.disabled = true;
        return;
    }

    divisionSelect.disabled = false;
    const region = HIER[currentFilters.region];
    if (region && region.divisions) {
        Object.keys(region.divisions).forEach(divCode => {
            const option = document.createElement('option');
            option.value = divCode;
            option.textContent = region.divisions[divCode].name;
            divisionSelect.appendChild(option);
        });
    }
}

function populateCccFilter() {
    const cccSelect = document.getElementById('cccFilter');
    cccSelect.innerHTML = '<option value="all">All CCCs</option>';

    if (currentFilters.division === 'all') {
        cccSelect.disabled = true;
        return;
    }

    cccSelect.disabled = false;
    const region = HIER[currentFilters.region];
    if (region) {
        const division = region.divisions[currentFilters.division];
        if (division && division.cccs) {
            Object.keys(division.cccs).forEach(cccCode => {
                const option = document.createElement('option');
                option.value = cccCode;
                option.textContent = division.cccs[cccCode];
                cccSelect.appendChild(option);
            });
        }
    }
}

async function refreshData() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('loading');
    await loadData();
    btn.classList.remove('loading');
}

function updateDashboard() {
    const filteredMeterData = applyFilters(meterDataRaw);
    const aggregatedData = aggregateData(filteredMeterData, workOrderDataRaw);

    updateSummaryCards(aggregatedData);
    renderTable(aggregatedData);
}

function applyFilters(data) {
    return data.filter(row => {
        if (currentFilters.meterType !== 'all' && row.meter_type !== currentFilters.meterType) {
            return false;
        }
        if (currentFilters.lot !== 'all' && row.Lot !== currentFilters.lot) {
            return false;
        }
        // Hierarchy filters
        const cccCode = row.ccc_final;
        if (currentFilters.region !== 'all' && getRegionForCCC(cccCode) !== currentFilters.region) {
            return false;
        }
        if (currentFilters.division !== 'all' && getDivisionForCCC(cccCode) !== currentFilters.division) {
            return false;
        }
        if (currentFilters.ccc !== 'all' && cccCode !== currentFilters.ccc) {
            return false;
        }
        return true;
    });
}

function aggregateData(meterData, woData) {
    let level;
    if (currentFilters.ccc !== 'all') {
        level = 'ccc';
    } else if (currentFilters.division !== 'all') {
        level = 'ccc'; // Show CCCs within the selected division
    } else if (currentFilters.region !== 'all') {
        level = 'division'; // Show divisions within the selected region
    } else {
        level = 'region'; // Default to region view
    }

    const aggregated = {};

    if (level === 'region') { // Display all regions
        Object.keys(HIER).forEach(regionCode => {
            const region = HIER[regionCode];
            if (currentFilters.region !== 'all' && currentFilters.region !== regionCode) {
                return; // Skip regions that are not selected
            }
            aggregated[regionCode] = {
                code: regionCode,
                name: region.name,
                woIssued: 0,
                meterIssued: 0,
                meterInstalled: 0,
                l1Completed: 0,
                breakdown: {}
            };
        });
        // Aggregate meter data
        meterData.forEach(row => {
            const cccCode = row.ccc_final;
            const regionCode = getRegionForCCC(cccCode);
            if (regionCode && aggregated[regionCode]) {
                const meterType = row.meter_type || 'N/A';
                if (!aggregated[regionCode].breakdown[meterType]) {
                    aggregated[regionCode].breakdown[meterType] = { meterIssued: 0, meterInstalled: 0, l1Completed: 0 };
                }

                if (row['Meter Supply  Qty.']) aggregated[regionCode].meterIssued++;
                if (row['Meter Installed Qty.  In Field_Active In Hes_']) aggregated[regionCode].meterInstalled++;
                if (row['Total Submit In Ami Portal']) aggregated[regionCode].l1Completed++;
                aggregated[regionCode].breakdown[meterType] = aggregateRowCounts(row, aggregated[regionCode].breakdown[meterType]);
            }
        });

        // Aggregate work order data
        woData.forEach(row => {
            const cccCode = row.CCC_code;
            const regionCode = getRegionForCCC(cccCode);
            if (regionCode && aggregated[regionCode] && row.WORK_ORDER) {
                aggregated[regionCode].woIssued++;
            }
        });

    } else if (level === 'division') { // Display divisions for the selected region
        if (currentFilters.region !== 'all') {
            const region = HIER[currentFilters.region];
            if (!region) return [];

            Object.keys(region.divisions).forEach(divCode => {
                if (currentFilters.division !== 'all' && currentFilters.division !== divCode) {
                    return; // Skip divisions that are not selected
                }
                const division = region.divisions[divCode];
                aggregated[divCode] = {
                    code: divCode,
                    name: division.name,
                    woIssued: 0,
                    meterIssued: 0,
                    meterInstalled: 0,
                    l1Completed: 0,
                    breakdown: {}
                };
            });
        }
        // Aggregate meter data
        meterData.forEach(row => {
            const cccCode = row.ccc_final;
            const divCode = getDivisionForCCC(cccCode);
            if (divCode && aggregated[divCode]) {
                const meterType = row.meter_type || 'N/A';
                if (!aggregated[divCode].breakdown[meterType]) {
                    aggregated[divCode].breakdown[meterType] = { meterIssued: 0, meterInstalled: 0, l1Completed: 0 };
                }

                if (row['Meter Supply  Qty.']) aggregated[divCode].meterIssued++;
                if (row['Meter Installed Qty.  In Field_Active In Hes_']) aggregated[divCode].meterInstalled++;
                if (row['Total Submit In Ami Portal']) aggregated[divCode].l1Completed++;
                aggregated[divCode].breakdown[meterType] = aggregateRowCounts(row, aggregated[divCode].breakdown[meterType]);
            }
        });

        // Aggregate work order data
        woData.forEach(row => {
            const cccCode = row.CCC_code;
            const divCode = getDivisionForCCC(cccCode);
            if (divCode && aggregated[divCode] && row.WORK_ORDER) {
                aggregated[divCode].woIssued++;
            }
        });

    } else if (level === 'ccc') { // Display CCCs for the selected division
        if (currentFilters.region !== 'all' && currentFilters.division !== 'all') {
            const division = HIER[currentFilters.region]?.divisions[currentFilters.division];
            if (!division) return [];

                Object.keys(division.cccs).forEach(cccCode => {
                    if (currentFilters.ccc !== 'all' && currentFilters.ccc !== cccCode) {
                        return; // Skip CCCs that are not selected
                    }
                    aggregated[cccCode] = {
                        code: cccCode,
                        name: division.cccs[cccCode],
                        woIssued: 0,
                        meterIssued: 0,
                        meterInstalled: 0,
                        l1Completed: 0,
                        breakdown: {}
                    };
                });
        }
         // Aggregate meter data
        meterData.forEach(row => {
            const cccCode = row.ccc_final;
            if (cccCode && aggregated[cccCode]) {
                const meterType = row.meter_type || 'N/A';
                if (!aggregated[cccCode].breakdown[meterType]) {
                    aggregated[cccCode].breakdown[meterType] = { meterIssued: 0, meterInstalled: 0, l1Completed: 0 };
                }

                if (row['Meter Supply  Qty.']) aggregated[cccCode].meterIssued++;
                if (row['Meter Installed Qty.  In Field_Active In Hes_']) aggregated[cccCode].meterInstalled++;
                if (row['Total Submit In Ami Portal']) aggregated[cccCode].l1Completed++;
                aggregated[cccCode].breakdown[meterType] = aggregateRowCounts(row, aggregated[cccCode].breakdown[meterType]);
            }
        });

        // Aggregate work order data
        woData.forEach(row => {
            const cccCode = row.CCC_code;
            if (cccCode && aggregated[cccCode] && row.WORK_ORDER) {
                aggregated[cccCode].woIssued++;
            }
        });
    }

    // Calculate unpush cases
    Object.keys(aggregated).forEach(key => {
        const group = aggregated[key];
        group.unpush = group.meterInstalled - group.l1Completed;
        Object.keys(group.breakdown).forEach(meterType => {
            const breakdownRow = group.breakdown[meterType];
            breakdownRow.unpush = breakdownRow.meterInstalled - breakdownRow.l1Completed;
        });
    });

    let finalData = Object.values(aggregated);

    return Object.values(aggregated);
}

function aggregateRowCounts(meterRow, target) {
    if (meterRow['Meter Supply  Qty.']) target.meterIssued++;
    if (meterRow['Meter Installed Qty.  In Field_Active In Hes_']) target.meterInstalled++;
    if (meterRow['Total Submit In Ami Portal']) target.l1Completed++;
    return target;
}

function getRegionForCCC(cccCode) {
    for (const regionCode in HIER) {
        const region = HIER[regionCode];
        for (const divCode in region.divisions) {
            const division = region.divisions[divCode];
            if (division.cccs[cccCode]) {
                return regionCode;
            }
        }
    }
    return null;
}

function getDivisionForCCC(cccCode) {
    for (const regionCode in HIER) {
        const region = HIER[regionCode];
        for (const divCode in region.divisions) {
            const division = region.divisions[divCode];
            if (division.cccs[cccCode]) {
                return divCode;
            }
        }
    }
    return null;
}

function updateSummaryCards(data) {
    const totals = data.reduce((acc, row) => {
        acc.woIssued += row.woIssued;
        acc.meterIssued += row.meterIssued;
        acc.meterInstalled += row.meterInstalled;
        acc.l1Completed += row.l1Completed;
        acc.unpush += row.unpush;
        return acc;
    }, { woIssued: 0, meterIssued: 0, meterInstalled: 0, l1Completed: 0, unpush: 0 });

    // Update summary cards
    document.getElementById('totalWO').textContent = totals.woIssued.toLocaleString();
    document.getElementById('totalIssued').textContent = totals.meterIssued.toLocaleString();
    document.getElementById('totalInstalled').textContent = totals.meterInstalled.toLocaleString();
    document.getElementById('totalCompleted').textContent = totals.l1Completed.toLocaleString();
    document.getElementById('totalUnpush').textContent = totals.unpush.toLocaleString();

    // Update table total row
    document.getElementById('totalRowWoIssued').textContent = totals.woIssued.toLocaleString();
    document.getElementById('totalRowMeterIssued').textContent = totals.meterIssued.toLocaleString();
    document.getElementById('totalRowMeterInstalled').textContent = totals.meterInstalled.toLocaleString();
    document.getElementById('totalRowL1Completed').textContent = totals.l1Completed.toLocaleString();
    document.getElementById('totalRowUnpush').textContent = totals.unpush.toLocaleString();

    // Aggregate the breakdown for the total row
    const totalBreakdown = data.reduce((breakdownAcc, row) => {
        for (const meterType in row.breakdown) {
            if (!breakdownAcc[meterType]) {
                breakdownAcc[meterType] = { meterIssued: 0, meterInstalled: 0, l1Completed: 0, unpush: 0 };
            }
            breakdownAcc[meterType].meterIssued += row.breakdown[meterType].meterIssued;
            breakdownAcc[meterType].meterInstalled += row.breakdown[meterType].meterInstalled;
            breakdownAcc[meterType].l1Completed += row.breakdown[meterType].l1Completed;
            breakdownAcc[meterType].unpush += row.breakdown[meterType].unpush;
        }
        return breakdownAcc;
    }, {});

    document.querySelector('.total-row').dataset.breakdown = JSON.stringify(totalBreakdown);

    // Update total progress in the table footer
    const totalProgressPercent = totals.meterIssued > 0 ? (totals.meterInstalled / totals.meterIssued * 100) : 0;
    const totalProgressCell = document.getElementById('totalRowProgress');
    totalProgressCell.textContent = `${totalProgressPercent.toFixed(1)}%`;
}

function renderTable(data) {
    const tbody = document.getElementById('tableBody');
    const noDataMsg = document.getElementById('noDataMessage');

    if (data.length === 0) {
        tbody.innerHTML = '';
        noDataMsg.style.display = 'block';
        return;
    }

    noDataMsg.style.display = 'none';

    // Apply sorting
    const sortedData = sortData(data);

    tbody.innerHTML = sortedData.map(row => {
        const progress = row.meterIssued > 0 ? (row.meterInstalled / row.meterIssued * 100) : 0;
        const breakdownData = JSON.stringify(row.breakdown); // Ensure breakdown data is stringified for the data attribute
        return `
            <tr class="main-row" data-breakdown='${breakdownData}' style="cursor: pointer;">
                <td><span class="expand-icon">▶</span> <strong>${row.name}</strong></td>
                <td>${row.woIssued.toLocaleString()}</td>
                <td>${row.meterIssued.toLocaleString()}</td>
                <td>${row.meterInstalled.toLocaleString()}</td>
                <td>${row.l1Completed.toLocaleString()}</td>
                <td>${row.unpush.toLocaleString()}</td>
                <td>
                    ${progress.toFixed(1)}%
                </td>
            </tr>
        `;
    }).join('');
}

function handleRowClick(e) {
    const mainRow = e.target.closest('.main-row, .total-row');
    if (!mainRow) return;
    
    const expandIcon = mainRow.querySelector('.expand-icon');
    
    // Toggle expanded state
    mainRow.classList.toggle('expanded');
    if (expandIcon) {
        expandIcon.classList.toggle('expanded');
    }

    const existingDetailRow = mainRow.nextElementSibling;
    if (existingDetailRow && existingDetailRow.classList.contains('detail-row')) {
        existingDetailRow.remove();
        return;
    }
    
    if (mainRow.classList.contains('expanded')) {
        const breakdownData = JSON.parse(mainRow.dataset.breakdown || '{}');
        const detailRow = document.createElement('tr');
        detailRow.className = 'detail-row';
        
        const detailCell = document.createElement('td'); 
        detailCell.colSpan = 7; // Span all columns
        detailCell.innerHTML = createBreakdownTable(breakdownData);

        detailRow.appendChild(detailCell);
        mainRow.after(detailRow);
    }
}

function createBreakdownTable(breakdownData) {
    const meterTypes = Object.keys(breakdownData);
    if (meterTypes.length === 0) {
        return '<div class="breakdown-container no-breakdown"><p>No meter-type breakdown available for this entry.</p></div>';
    }

    const rowsHtml = meterTypes.sort().map(type => {
        const data = breakdownData[type];
        const progress = data.meterIssued > 0 ? (data.meterInstalled / data.meterIssued * 100) : 0;
        return `
            <tr class="breakdown-row" data-meter-type="${type}" style="cursor: pointer;">
                <td>${type}</td>
                <td>${data.meterIssued.toLocaleString()}</td>
                <td>${data.meterInstalled.toLocaleString()}</td>
                <td>${data.l1Completed.toLocaleString()}</td>
                <td>${data.unpush.toLocaleString()}</td>
                <td>
                    ${progress.toFixed(1)}%
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div class="breakdown-container" onclick="handleBreakdownRowClick(event)">
            <table class="breakdown-table">
                <thead><tr><th>Meter Type</th><th>Issued</th><th>Installed</th><th>L1 Done</th><th>Un-push</th><th>Progress</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>`;
}

function handleBreakdownRowClick(event) {
    const breakdownRow = event.target.closest('.breakdown-row');
    if (!breakdownRow) return;

    const mainRow = breakdownRow.closest('.detail-row').previousElementSibling;
    const officeCode = mainRow.classList.contains('total-row') ? 'all' : mainRow.dataset.breakdown ? JSON.parse(mainRow.dataset.breakdown).code : null;
    const meterType = breakdownRow.dataset.meterType;

    if (!meterType) return;

    // Filter raw data for the modal
    const modalData = meterDataRaw.filter(row => {
        const rowOfficeCode = getOfficeCodeForLevel(row.ccc_final, mainRow.dataset.level);
        const officeMatch = (officeCode === 'all') || (rowOfficeCode === officeCode);
        const meterTypeMatch = row.meter_type === meterType;
        return officeMatch && meterTypeMatch;
    });

    // Populate and show modal
    populateAndShowModal(modalData, meterType);
}

function populateAndShowModal(data, meterType) {
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalTableBody');

    modalTitle.textContent = `Details for ${meterType}`;
    
    if (data.length === 0) {
        modalBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No detailed data available.</td></tr>';
    } else {
        modalBody.innerHTML = data.map(row => {
            const cccName = HIER[getRegionForCCC(row.ccc_final)]?.divisions[getDivisionForCCC(row.ccc_final)]?.cccs[row.ccc_final] || row.ccc_final;
            const isPushed = row['Total Submit In Ami Portal'] ? 'Yes' : 'No';
            return `
                <tr>
                    <td>${cccName}</td>
                    <td>${row.con_id || 'N/A'}</td>
                    <td>${row.con_id || 'N/A'}</td>
                    <td>${isPushed}</td>
                    <td>${row.Lot || 'N/A'}</td>
                </tr>
            `;
        }).join('');
    }

    showModal(true);
}



function handleSort(column) {
    if (sortConfig.column === column) {
        sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
    } else {
        sortConfig.column = column;
        sortConfig.direction = 'asc';
    }
    updateDashboard();
}

function sortData(data) {
    if (!sortConfig.column) return data;

    return [...data].sort((a, b) => {
        let aVal = a[sortConfig.column];
        let bVal = b[sortConfig.column];

        // Handle string comparison for name
        if (sortConfig.column === 'name') {
            aVal = aVal.toString().toLowerCase();
            bVal = bVal.toString().toLowerCase();
        }

        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });
}

function exportToCSV() {
    const filteredMeterData = applyFilters(meterDataRaw);
    const aggregatedData = aggregateData(filteredMeterData, workOrderDataRaw);

    const headers = ['Office Name', 'WO Issued', 'Meter Issued', 'Meter Installed', 'L1 Completed', 'Un-push Case'];
    const rows = aggregatedData.map(row => [
        row.name,
        row.woIssued,
        row.meterIssued,
        row.meterInstalled,
        row.l1Completed,
        row.unpush
    ]);

    const csv = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-meter-dashboard-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

function showModal(show) {
    const modal = document.getElementById('detailModal');
    if (show) {
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('visible'), 10);
    } else {
        modal.classList.remove('visible');
        setTimeout(() => modal.style.display = 'none', 300); // Match transition duration
    }
}

function getOfficeCodeForLevel(cccCode, level) {
    if (level === 'region') return getRegionForCCC(cccCode);
    if (level === 'division') return getDivisionForCCC(cccCode);
    if (level === 'ccc') return cccCode;
    return null;
}
