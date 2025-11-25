// Sorting functionality for table
let sortOrders = [false, false, false, false, false]; // Track sort direction for each column

function sortTable(columnIndex) {
    const table = document.getElementById('lowConsumersTable');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    
    // Skip the "no data" message row
    if (rows.length === 1 && rows[0].querySelector('td').colSpan > 1) {
        return;
    }
    
    // If sorting by S.No column, don't actually sort
    if (columnIndex === 0) {
        return;
    }
    
    // Toggle sort direction
    sortOrders[columnIndex] = !sortOrders[columnIndex];
    
    // Sort rows
    rows.sort((a, b) => {
        const cellA = a.querySelector(`td:nth-child(${columnIndex + 1})`);
        const cellB = b.querySelector(`td:nth-child(${columnIndex + 1})`);
        
        let valueA = cellA.textContent.trim();
        let valueB = cellB.textContent.trim();
        
        // Try to convert to number for numeric columns
        const numA = parseFloat(valueA);
        const numB = parseFloat(valueB);
        
        if (!isNaN(numA) && !isNaN(numB)) {
            return sortOrders[columnIndex] ? numA - numB : numB - numA;
        } else {
            return sortOrders[columnIndex] ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA);
        }
    });
    
    // Update sort indicator
    const headers = table.querySelectorAll('th');
    headers.forEach((header, index) => {
        const indicator = header.querySelector('.sort-indicator');
        if (index === columnIndex) {
            indicator.textContent = sortOrders[columnIndex] ? '↑' : '↓';
        } else {
            indicator.textContent = '⇅';
        }
    });
    
    // Reorder rows in DOM and update serial numbers
    rows.forEach((row, index) => {
        const serialCell = row.querySelector('td:first-child');
        serialCell.textContent = index + 1;
        tbody.appendChild(row);
    });
}

// Simple CSV parser to avoid CDN dependency
function parseCSV(csv) {
    const lines = csv.trim().split('\n');
    if (lines.length === 0) return [];
    
    const headers = lines[0].split(',').map(h => h.trim());
    const data = [];
    
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        
        // Simple CSV parsing that handles quoted fields
        const values = [];
        let current = '';
        let inQuotes = false;
        
        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(current.trim().replace(/^"|"$/g, ''));
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current.trim().replace(/^"|"$/g, ''));
        
        const obj = {};
        headers.forEach((header, idx) => {
            obj[header] = values[idx] || '';
        });
        data.push(obj);
    }
    
    return data;
}

document.addEventListener('DOMContentLoaded', () => {
    const analyzeBtn = document.getElementById('analyzeBtn');
    const statusFilter = document.getElementById('statusFilter');
    const sdMultiplierSelect = document.getElementById('sdMultiplier');
    const loadingDiv = document.getElementById('loading');
    const loadingText = document.getElementById('loading-text');
    const resultsDiv = document.getElementById('results');
    const summaryTable = document.getElementById('summaryTable');
    const lowConsumersTableBody = document.querySelector('#lowConsumersTable tbody');
    const csvFileInput = document.getElementById('csvFileInput'); // New: Get file input
    const resetBtn = document.getElementById('resetBtn');

    // Collapsible instructions
    const collapsible = document.querySelector('.collapsible-header');
    collapsible.addEventListener('click', function() {
        this.classList.toggle('active');
        const content = this.nextElementSibling;
        const icon = this.querySelector('.collapsible-icon');
        if (content.style.maxHeight) {
            content.style.maxHeight = null;
            icon.textContent = '+';
        } else {
            // Set padding and border to calculate scrollHeight correctly
            content.style.padding = '15px 18px';
            content.style.maxHeight = content.scrollHeight + "px";
            icon.textContent = '−';
        }
    });

    // Reset button functionality
    resetBtn.addEventListener('click', () => {
        loadingDiv.classList.add('hidden');
        resetBtn.classList.add('hidden');
        csvFileInput.value = ''; // Clear the file input
    });

    // Pagination state
    let currentPage = 1;
    const rowsPerPage = 15; // You can adjust this number
    let fullLowConsumersList = [];
    const paginationContainer = document.getElementById('paginationContainer');

    let distributionChart = null;  // Store chart instance

    const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vROjZfltKm0IT0nUmXwg-wqZIwcg5szwuojUXEov7ir_ZIOwjhOkdyVSK5-37lf3TzK7D9oHUtFoiBF/pub?gid=0&single=true&output=csv';

    // Define the columns that contain the monthly consumption data
    const consumptionColumns = [
        'UNIT_BILLED_DEC24', 'UNIT_BILLED_JAN25', 'UNIT_BILLED_FEB25', 'UNIT_BILLED_MAR25',
        'UNIT_BILLED_APR25', 'UNIT_BILLED_MAY25', 'UNIT_BILLED_JUN25', 'UNIT_BILLED_JUL25',
        'UNIT_BILLED_AUG25', 'UNIT_BILLED_SEP25', 'UNIT_BILLED_OCT25', 'UNIT_BILLED_NOV25'
    ];

    analyzeBtn.addEventListener('click', () => {
        loadingDiv.classList.remove('hidden');
        resultsDiv.classList.add('hidden');
        paginationContainer.classList.add('hidden'); // Hide pagination on new analysis
        resetBtn.classList.add('hidden'); // Hide reset button initially
        document.querySelector('#loading .spinner').style.display = 'block'; // Show spinner
        lowConsumersTableBody.innerHTML = '';
        summaryTable.innerHTML = '';
        document.getElementById('lowConsumersHeader').textContent = 'Low Consumption Consumers'; // Reset header

        const file = csvFileInput.files[0];

        if (file) {
            loadingText.textContent = `Reading file: ${file.name}...`;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const csvText = e.target.result;

                    // Validate CSV headers
                    const firstLine = csvText.split('\n')[0].trim();
                    const uploadedHeaders = firstLine.split(',').map(h => h.trim());
                    const requiredHeaders = ['ZCA', 'NAME', 'CONN_STAT', ...consumptionColumns];
                    const missingHeaders = requiredHeaders.filter(h => !uploadedHeaders.includes(h));

                    if (missingHeaders.length > 0) {
                        const errorMessage = `Invalid CSV format. Missing required columns: ${missingHeaders.join(', ')}. Please check the data format instructions.`;
                        document.querySelector('#loading .spinner').style.display = 'none'; // Hide spinner
                        loadingText.textContent = errorMessage;
                        resetBtn.classList.remove('hidden'); // Show reset button
                        return; // Stop processing
                    }

                    const data = parseCSV(csvText);
                    loadingText.textContent = `Processing data from ${file.name}...`;
                    processData(data);
                } catch (err) {
                    loadingText.textContent = `Error processing file: ${err.message}`;
                }
            };
            reader.onerror = () => {
                loadingText.textContent = `Error reading file: ${reader.error}`;
                loadingDiv.classList.remove('hidden'); // Ensure it stays visible to show error
            };
            reader.readAsText(file);
        } else {
            loadingText.textContent = 'Loading and processing data from default URL...';
            fetch(DATA_URL)
                .then(response => response.text())
                .then(csvText => {
                    const data = parseCSV(csvText);
                    loadingText.textContent = 'Processing data from default URL...';
                    processData(data);
                })
                .catch(err => {
                    loadingText.textContent = `Error loading data from URL: ${err.message}`;
                    loadingDiv.classList.remove('hidden'); // Ensure it stays visible to show error
                });
        }
    });

    // Setup pagination button listeners once
    document.getElementById('prevPageBtn').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderTablePage();
        }
    });
    document.getElementById('nextPageBtn').addEventListener('click', () => {
        const totalPages = Math.ceil(fullLowConsumersList.length / rowsPerPage);
        if (currentPage < totalPages) {
            currentPage++;
            renderTablePage();
        }
    });

    function processData(data) {
        const selectedStatus = statusFilter.value;
        const sdMultiplier = parseFloat(sdMultiplierSelect.value);

        // 1. Filter consumers by connection status and calculate total consumption
        const consumersWithTotalConsumption = data
            .filter(row => row.CONN_STAT === selectedStatus)
            .map(row => {
                const totalConsumption = consumptionColumns.reduce((sum, col) => {
                    // Treat "(null)" as null value
                    let value = row[col];
                    if (value === '(null)' || value === null || value === undefined) {
                        return sum;
                    }
                    const consumption = parseFloat(value);
                    return sum + (isNaN(consumption) ? 0 : consumption);
                }, 0);

                // Count months with non-zero consumption data
                const monthsWithData = consumptionColumns.filter(col => {
                    let value = row[col];
                    if (value === '(null)' || value === null || value === undefined || value === '') {
                        return false;
                    }
                    const consumption = parseFloat(value);
                    return !isNaN(consumption) && consumption > 0;
                }).length;

                return {
                    zca: row.ZCA,
                    name: row.NAME,
                    totalConsumption: totalConsumption,
                    monthsWithData: monthsWithData
                };
            });

        if (consumersWithTotalConsumption.length === 0) {
            loadingText.textContent = `No consumers found with status "${selectedStatus}".`;
            // Keep the loading div visible to show the message, but don't show results.
            return;
        }

        const consumptionValues = consumersWithTotalConsumption.map(c => c.totalConsumption);

        // 2. Calculate statistics
        const stats = calculateStatistics(consumptionValues);
        const lowConsumptionThreshold = stats.mean - (sdMultiplier * stats.stdDev);

        // 3. Identify low-consumption consumers
        const lowConsumers = consumersWithTotalConsumption.filter(
            c => c.totalConsumption < lowConsumptionThreshold
        );

        // Update description text
        const lowConsumersDescription = document.getElementById('lowConsumersDescription');
        lowConsumersDescription.textContent = `Consumers whose total consumption is more than ${sdMultiplier} standard deviation(s) below the mean.`;

        // 4. Display results
        displaySummary(stats, consumersWithTotalConsumption.length, lowConsumptionThreshold, sdMultiplier, lowConsumers.length);
        displayFormula(stats, lowConsumptionThreshold, sdMultiplier);
        displayChart(consumersWithTotalConsumption, stats, lowConsumptionThreshold);
        displayLowConsumers(lowConsumers);

        loadingDiv.classList.add('hidden');
        resultsDiv.classList.remove('hidden');
    }

    function calculateStatistics(arr) {
        const n = arr.length;
        if (n === 0) return { mean: 0, stdDev: 0 };

        const mean = arr.reduce((a, b) => a + b) / n;
        const stdDev = Math.sqrt(arr.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n);

        return { mean, stdDev };
    }

    function displaySummary(stats, totalConsumers, threshold, sdMultiplier, lowConsumersCount) {
        summaryTable.innerHTML = `
            <tr><td>Total Consumers Analyzed (${statusFilter.value})</td><td>${totalConsumers}</td></tr>
            <tr><td>Average Consumption</td><td>${stats.mean.toFixed(2)}</td></tr>
            <tr><td>Standard Deviation</td><td>${stats.stdDev.toFixed(2)}</td></tr>
            <tr><td>Low Consumption Threshold (&lt; Mean - ${sdMultiplier}σ)</td><td>${threshold.toFixed(2)}</td></tr>
            <tr><td>Low Consumption Consumers Found</td><td>${lowConsumersCount}</td></tr>
        `;
    }

    function displayFormula(stats, threshold, sdMultiplier) {
        const formulaBox = document.getElementById('formulaBox');
        formulaBox.innerHTML = `
            <div class="formula-line">
                <span class="formula-label">Average Consumption (μ):</span> ${stats.mean.toFixed(2)} units
            </div>
            <div class="formula-line">
                <span class="formula-label">Standard Deviation (σ):</span> ${stats.stdDev.toFixed(2)} units (x${sdMultiplier})
            </div>
            <div class="formula-line">
                <span class="formula-label">Low Consumption Threshold:</span> μ - ${sdMultiplier}σ = ${stats.mean.toFixed(2)} - ${sdMultiplier} * ${stats.stdDev.toFixed(2)} = <strong>${threshold.toFixed(2)}</strong> units
            </div>
            <div class="formula-line" style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #bdc3c7;">
                Consumers with total consumption &lt; <strong>${threshold.toFixed(2)}</strong> are classified as low-consumption consumers.
            </div>
        `;
    }

    function displayChart(consumersData, stats, threshold) {
        const ctx = document.getElementById('distributionChart').getContext('2d');
        
        // Destroy previous chart if it exists
        if (distributionChart !== null) {
            distributionChart.destroy();
        }
        
        // Create histogram data
        const min = Math.min(...consumersData.map(c => c.totalConsumption));
        const max = Math.max(...consumersData.map(c => c.totalConsumption));
        const binCount = 20;
        const binWidth = (max - min) / binCount;
        const bins = Array(binCount).fill(0);
        const binLabels = [];
        
        consumersData.forEach(c => {
            const binIndex = Math.min(Math.floor((c.totalConsumption - min) / binWidth), binCount - 1);
            bins[binIndex]++;
        });
        
        for (let i = 0; i < binCount; i++) {
            const binStart = (min + i * binWidth).toFixed(0);
            const binEnd = (min + (i + 1) * binWidth).toFixed(0);
            binLabels.push(`${binStart}-${binEnd}`);
        }
        
        // Generate data for the normal distribution curve
        const normalDistributionData = [];
        const normalPDF = (x, mean, stdDev) => {
            if (stdDev === 0) return x === mean ? Infinity : 0;
            return (1 / (stdDev * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * Math.pow((x - mean) / stdDev, 2));
        };

        const totalConsumers = consumersData.length;
        for (let i = 0; i < binCount; i++) {
            const binCenter = min + (i + 0.5) * binWidth;
            // Scale PDF to match histogram counts (PDF * N * binWidth)
            const expectedCount = normalPDF(binCenter, stats.mean, stats.stdDev) * totalConsumers * binWidth;
            normalDistributionData.push(expectedCount);
        }

        // Generate colors for bars based on the threshold
        const lowConsumptionColor = 'rgba(255, 159, 64, 0.6)'; // Orange for low consumption
        const lowConsumptionBorder = 'rgba(255, 159, 64, 1)';
        const normalColor = 'rgba(52, 152, 219, 0.6)'; // Blue for normal
        const normalBorder = 'rgba(52, 152, 219, 1)';
        const barBackgroundColors = [];
        const barBorderColors = [];

        for (let i = 0; i < binCount; i++) {
            const binEnd = min + (i + 1) * binWidth;
            barBackgroundColors.push(binEnd < threshold ? lowConsumptionColor : normalColor);
            barBorderColors.push(binEnd < threshold ? lowConsumptionBorder : normalBorder);
        }
        distributionChart = new Chart(ctx, {
            type: 'bar', // This remains 'bar', the line chart is a separate dataset
            data: {
                labels: binLabels,
                datasets: [
                    {
                        type: 'line', // This dataset will be a line chart
                        label: 'Normal Distribution',
                        data: normalDistributionData,
                        borderColor: 'rgba(231, 76, 60, 1)',
                        backgroundColor: 'rgba(231, 76, 60, 0.2)',
                        borderWidth: 2,
                        pointRadius: 0, // Hide points on the line
                        yAxisID: 'y' // Ensure it uses the same y-axis
                    },
                    {
                        label: 'Consumer Count',
                        data: bins,
                        backgroundColor: barBackgroundColors,
                        borderColor: barBorderColors,
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: `Consumption Distribution (μ=${stats.mean.toFixed(2)}, σ=${stats.stdDev.toFixed(2)})`
                    },
                    legend: {
                        display: true
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true, // ID is 'y' by default
                        title: {
                            display: true,
                            text: 'Number of Consumers'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Consumption Range (Units)'
                        }
                    }
                }
            }
        });
    }

    function displayLowConsumers(consumers) {
        const lowConsumersHeader = document.getElementById('lowConsumersHeader');
        lowConsumersHeader.textContent = `Low Consumption Consumers (${consumers.length})`;

        if (consumers.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 5;
            cell.textContent = 'No consumers found below the low consumption threshold.';
            row.appendChild(cell);
            lowConsumersTableBody.appendChild(row);
            document.getElementById('downloadBtn').classList.add('hidden');
            paginationContainer.classList.add('hidden');
            return;
        }

        // Show download button and attach data
        const downloadBtn = document.getElementById('downloadBtn');
        downloadBtn.classList.remove('hidden');

        // Clone and replace the button to remove old event listeners
        const newDownloadBtn = downloadBtn.cloneNode(true);
        downloadBtn.parentNode.replaceChild(newDownloadBtn, downloadBtn);

        newDownloadBtn.addEventListener('click', () => {
            downloadTableAsCSV(consumers);
        });

        // Store full list and render first page
        fullLowConsumersList = consumers;
        currentPage = 1;
        if (fullLowConsumersList.length > rowsPerPage) {
            paginationContainer.classList.remove('hidden');
        }
        renderTablePage();
    }

    function renderTablePage() {
        lowConsumersTableBody.innerHTML = '';

        const startIndex = (currentPage - 1) * rowsPerPage;
        const endIndex = startIndex + rowsPerPage;
        const paginatedConsumers = fullLowConsumersList.slice(startIndex, endIndex);

        paginatedConsumers.forEach((consumer, index) => {
            const globalIndex = startIndex + index; // Use this for the original index if needed
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${globalIndex + 1}</td>
                <td>${consumer.zca}</td>
                <td>${consumer.name}</td>
                <td>${consumer.monthsWithData}</td>
                <td>${consumer.totalConsumption.toFixed(2)}</td>
            `;
            lowConsumersTableBody.appendChild(row);
        });

        // Update page info and button states
        const totalPages = Math.ceil(fullLowConsumersList.length / rowsPerPage);
        document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
        document.getElementById('prevPageBtn').disabled = currentPage === 1;
        document.getElementById('nextPageBtn').disabled = currentPage === totalPages;
    }

    function displayLowConsumers_old(consumers) {
        consumers.forEach((consumer, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${index + 1}</td>
                <td>${consumer.zca}</td>
                <td>${consumer.name}</td>
                <td>${consumer.monthsWithData}</td>
                <td>${consumer.totalConsumption.toFixed(2)}</td>
            `;
            lowConsumersTableBody.appendChild(row);
        });
    }

    function downloadTableAsCSV(consumers) {
        const title = 'Low Consumption Consumers';
        const headers = ['S.No', 'ZCA', 'Name', 'Months with Data', 'Total Consumption'];
        const csvRows = [title, '', headers.join(',')]; // Add title, a blank line, and then headers

        consumers.forEach((consumer, index) => {
            const values = [
                index + 1,
                `"${consumer.zca}"`,
                `"${consumer.name.replace(/"/g, '""')}"`, // Handle names with quotes
                consumer.monthsWithData,
                consumer.totalConsumption.toFixed(2)
            ];
            csvRows.push(values.join(','));
        });

        const csvString = csvRows.join('\n');
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', 'low-consumption-consumers.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
});