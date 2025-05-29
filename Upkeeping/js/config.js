// Application Configuration
const CONFIG = {
    // Scoring system configuration
    scoring: {
        cleanliness: {
            maxPointsPerItem: 6,
            scoreOptions: [
                { value: 0, label: '0', class: 'bad' },
                { value: 1, label: '1', class: 'average' },
                { value: 2, label: '2', class: 'good' }
            ]
        },
        defective: {
            maxPointsPerItem: 2,
            scoreOptions: [
                { value: 2, label: 'No', class: 'no' },
                { value: 1, label: 'Few', class: 'few' },
                { value: 0, label: 'Yes', class: 'yes' }
            ]
        }
    },

    // Data definitions
    data: {
        cleanlinessItems: [
            { name: 'Control room-inside', maxPoints: 6 },
            { name: 'Control room-outside', maxPoints: 6 },
            { name: 'Bathroom', maxPoints: 6 },
            { name: 'Battery Room', maxPoints: 6 },
            { name: 'Roof and surroundings', maxPoints: 6 }
        ],
        
        defectiveItems: [
            { name: 'Lightning Arrester', maxPoints: 2 },
            { name: 'Insulator', maxPoints: 2 },
            { name: 'Circuit Breaker', maxPoints: 2 },
            { name: 'Transformer', maxPoints: 2 },
            { name: 'Busbar', maxPoints: 2 },
            { name: 'Control Panel', maxPoints: 2 },
            { name: 'Battery', maxPoints: 2 },
            { name: 'Earthing System', maxPoints: 2 }
        ],

        substations: {
            'North Division': ['Rajouri Garden 33kV', 'Pitampura 66kV', 'Model Town 33kV', 'Rohini 220kV'],
            'South Division': ['Vasant Kunj 66kV', 'Saket 33kV', 'Hauz Khas 66kV', 'Greater Kailash 33kV'],
            'East Division': ['Patparganj 220kV', 'Preet Vihar 66kV', 'Laxmi Nagar 33kV', 'Gandhi Nagar 66kV'],
            'West Division': ['Janakpuri 66kV', 'Tilak Nagar 33kV', 'Punjabi Bagh 66kV', 'Patel Nagar 33kV'],
            'Central Division': ['Kashmere Gate 220kV', 'IP Estate 66kV', 'Connaught Place 33kV', 'Karol Bagh 66kV']
        }
    },

    // UI Configuration
    ui: {
        progressClasses: {
            good: 'score-good',
            average: 'score-average',
            bad: 'score-bad'
        }
    }
};