// Progress Bar Component
const ProgressComponent = {
    container: null,

    init: (containerId) => {
        ProgressComponent.container = document.getElementById(containerId);
        ProgressComponent.render();
    },

    render: () => {
        ProgressComponent.container.innerHTML = `
            <div class="progress-card">
                <div class="progress-header">
                    <div class="progress-title">Overall Progress</div>
                    <div class="progress-score">
                        <span class="total-score" id="overallScore">0</span>
                        <span>/</span>
                        <span class="max-score" id="maxScore">13</span>
                        <span style="margin-left: 8px; color: #999;">items</span>
                        <span style="margin-left: 12px;">|</span>
                        <span class="total-score" id="totalPoints" style="margin-left: 12px;">0</span>
                        <span>/</span>
                        <span class="max-score" id="maxPoints">46</span>
                        <span style="margin-left: 8px; color: #999;">pts</span>
                    </div>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar" id="progressBar"></div>
                </div>
            </div>
        `;
    },

    update: (totalCompleted, totalItems, totalPoints, maxPoints) => {
        document.getElementById('overallScore').textContent = totalCompleted;
        document.getElementById('maxScore').textContent = totalItems;
        document.getElementById('totalPoints').textContent = totalPoints;
        document.getElementById('maxPoints').textContent = maxPoints;
        
        const progressPercentage = Utils.calculateProgress(totalCompleted, totalItems);
        document.getElementById('progressBar').style.width = progressPercentage + '%';
    }
};