// Form Component
const FormComponent = {
    container: null,

    init: (containerId) => {
        FormComponent.container = document.getElementById(containerId);
        FormComponent.render();
        FormComponent.attachEventListeners();
    },

    render: () => {
        FormComponent.container.innerHTML = `
            <div class="form-card">
                <div class="form-row">
                    <select class="form-select" id="division">
                        <option value="">Select Division</option>
                        ${Object.keys(CONFIG.data.substations).map(division => 
                            `<option value="${division}">${division}</option>`
                        ).join('')}
                    </select>
                    <select class="form-select" id="ssName">
                        <option value="">Select Substation</option>
                    </select>
                </div>
                <div class="form-row">
                    <input type="date" class="form-input" id="visitDate">
                    <input type="text" class="form-input" id="supervisor" placeholder="Supervising DE/AE Name">
                </div>
            </div>
        `;
    },

    attachEventListeners: () => {
        document.getElementById('division').addEventListener('change', FormComponent.updateSubstations);
    },

    updateSubstations: () => {
        const divisionSelect = document.getElementById('division');
        const ssSelect = document.getElementById('ssName');
        const selectedDivision = divisionSelect.value;
        
        ssSelect.innerHTML = '<option value="">Select Substation</option>';
        
        if (selectedDivision && CONFIG.data.substations[selectedDivision]) {
            CONFIG.data.substations[selectedDivision].forEach(ss => {
                const option = Utils.createElement('option', { value: ss }, ss);
                ssSelect.appendChild(option);
            });
        }
    }
};