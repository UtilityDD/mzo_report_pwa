// Utility Functions
const Utils = {
    // Calculate progress percentage
    calculateProgress: (completed, total) => {
        return total > 0 ? (completed / total) * 100 : 0;
    },

    // Get progress class based on completion percentage
    getProgressClass: (completed, total) => {
        const percentage = Utils.calculateProgress(completed, total);
        if (percentage === 100) return CONFIG.ui.progressClasses.good;
        if (percentage >= 50) return CONFIG.ui.progressClasses.average;
        return CONFIG.ui.progressClasses.bad;
    },

    // Create DOM element with attributes
    createElement: (tag, attributes = {}, textContent = '') => {
        const element = document.createElement(tag);
        Object.entries(attributes).forEach(([key, value]) => {
            if (key === 'className') {
                element.className = value;
            } else {
                element.setAttribute(key, value);
            }
        });
        if (textContent) element.textContent = textContent;
        return element;
    },

    // Calculate total points for an item category
    calculateTotalPoints: (items) => {
        return items.reduce((sum, item) => sum + (item.score || 0), 0);
    },

    // Count completed items
    countCompleted: (items) => {
        return items.filter(item => item.score !== null).length;
    }
};