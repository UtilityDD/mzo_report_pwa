// Main Application
const App = {
    cleanlinessItems: [],
    defectiveItems: [],

    init: () => {
        // Initialize data
        App.cleanlinessItems = CONFIG.data.cleanlinessItems.map(item => ({...item, score: null}));
        App.defectiveItems = CONFIG.data.defectiveItems.map(item => ({...item, score: null}));

        // Initialize components
        ProgressComponent.init('progressContainer');
        FormComponent.init('formContainer');
        App.initializeScoreCards();
        
        // Initial update
        App.updateAllScores();
    },

    initializeScoreCards: () => {
        const container = document.getElementById('scoreCardsContainer');
        
        // Cleanliness card
        const cleanlinessCard = ScoreCardComponent.createScoreCard(
            'cleanliness', 
            'Cleanliness', 
            App.cleanlinessItems, 
            30
        );
        container.appendChild(cleanlinessCard);
        
        // Defective items card
        const defectiveCard = ScoreCardComponent.createScoreCard(
            'defective', 
            'Defective Items', 
            App.defectiveItems, 
            16
        );
        container.appendChild(defectiveCard);
        
        // Populate items
        ScoreCardComponent.populateItems('cleanliness', App.cleanlinessItems, CONFIG.scoring.cleanliness.scoreOptions);
        ScoreCardComponent.populateItems('defective', App.defectiveItems, CONFIG.scoring.defective.scoreOptions);
    },

    setScore: (type, itemIndex, score) => {
        if (type === 'cleanliness') {
            App.cleanlinessItems[itemIndex].score = score;
            ScoreCardComponent.populateItems('cleanliness', App.cleanlinessItems, CONFIG.scoring.cleanliness.scoreOptions);
        } else if (type === 'defective') {
            App.defectiveItems[itemIndex].score = score;
            ScoreCardComponent.populateItems('defective', App.defectiveItems, CONFIG.scoring.defective.scoreOptions);
        }
        
        App.updateAllScores();
    },

    updateAllScores: () => {
        // Calculate cleanliness scores
        const cleanlinessCompleted = Utils.countCompleted(App.cleanlinessItems);
        const cleanlinessTotal = Utils.calculateTotalPoints(App.cleanlinessItems);
        
        // Calculate defective scores
        const defectiveCompleted = Utils.countCompleted(App.defectiveItems);
        const defectiveTotal = Utils.calculateTotalPoints(App.defectiveItems);
        
        // Update individual card displays
        App.updateCardScore('cleanliness', cleanlinessCompleted, cleanlinessTotal, 5);
        App.updateCardScore('defective', defectiveCompleted, defectiveTotal, 8);
        
        // Update overall progress
        const totalCompleted = cleanlinessCompleted + defectiveCompleted;
        const totalPoints = cleanlinessTotal + defectiveTotal;
        ProgressComponent.update(totalCompleted, 13, totalPoints, 46);
    },

    updateCardScore: (type, completed, points, maxItems) => {
        const scoreElement = document.getElementById(type + 'Score');
        scoreElement.textContent = `${completed}/${points}`;
        scoreElement.className = `current-score ${Utils.getProgressClass(completed, maxItems)}`;
    }
};

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', App.init);