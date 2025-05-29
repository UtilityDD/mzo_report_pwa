// Score Card Component
const ScoreCardComponent = {
    expandedSections: {},

    createScoreCard: (type, title, items, maxPoints) => {
        const itemCount = items.length;
        const cardElement = Utils.createElement('div', { className: 'score-card' });
        
        cardElement.innerHTML = `
            <div class="score-header ${type === 'defective' ? 'defective' : ''}" id="${type}Header" onclick="ScoreCardComponent.toggleSection('${type}')">
                <div class="score-title">${title}</div>
                <div class="score-info">
                    <div class="max-points">Items: ${itemCount} | Max: ${maxPoints}pts</div>
                    <div class="current-score" id="${type}Score">0/0</div>
                    <svg class="chevron" id="${type}Chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                    </svg>
                </div>
            </div>
            <div class="score-content" id="${type}Content">
                <div class="score-items" id="${type}Items"></div>
            </div>
        `;
        
        return cardElement;
    },

    toggleSection: (section) => {
        const content = document.getElementById(section + 'Content');
        const header = document.getElementById(section + 'Header');
        const chevron = document.getElementById(section + 'Chevron');
        
        ScoreCardComponent.expandedSections[section] = !ScoreCardComponent.expandedSections[section];
        
        if (ScoreCardComponent.expandedSections[section]) {
            content.classList.add('expanded');
            header.classList.add('active');
            chevron.classList.add('rotated');
        } else {
            content.classList.remove('expanded');
            header.classList.remove('active');
            chevron.classList.remove('rotated');
        }
    },

    populateItems: (type, items, scoreOptions) => {
        const container = document.getElementById(type + 'Items');
        container.innerHTML = '';

        items.forEach((item, index) => {
            const itemElement = Utils.createElement('div', { className: 'score-item' });
            
            const buttonsHtml = scoreOptions.map(option => 
                `<button class="score-btn ${type === 'defective' ? 'defective-btn' : ''} ${option.class} ${item.score === option.value ? 'selected' : ''}" 
                         onclick="App.setScore('${type}', ${index}, ${option.value})">${option.label}</button>`
            ).join('');
            
            itemElement.innerHTML = `
                <div class="item-name">${item.name}</div>
                <div class="item-controls">${buttonsHtml}</div>
            `;
            
            container.appendChild(itemElement);
        });
    }
};