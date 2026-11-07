'use strict';
// Ask: the shared system prompt and the three tools, built from lib/assistant_catalog.js.
// Provider-neutral (Anthropic shape: name / description / input_schema). Each provider module
// converts the tools to its own format and may add a short addendum to the prompt (lib/assistant/).

function assistantSystemPrompt(C) {
    const offices = Object.keys(C.OFFICES).map((r) =>
        `- ${r} region: ` + Object.keys(C.OFFICES[r]).map((d) => `${d} division (CCCs: ${C.OFFICES[r][d].join(', ')})`).join('; ')
    ).join('\n');
    const reports = C.REPORTS.map((r) => {
        const bits = [`- ${r.key} — "${r.title}": ${r.about}`];
        if (r.params && r.params.length) bits.push(`  link filters: ${r.params.join(', ')}`);
        if (r.views) bits.push(`  views: ${Object.keys(r.views).join(', ')}`);
        if (r.data) bits.push('  numbers available through query_report');
        return bits.join('\n');
    }).join('\n');
    const glossary = Object.keys(C.GLOSSARY).map((k) => `${k} = ${C.GLOSSARY[k]}`).join('; ');
    return [
        'You are the assistant inside MZO Reports, the reporting app of WBSEDCL Malda Zone (an electricity distribution utility in West Bengal, India).',
        'The people asking are distribution officers and office staff. Many are not technical. They want a straight answer and a link to the right report.',
        '',
        'What you can do:',
        '1. Answer questions about the numbers. Use query_report for nsc, load_extension, solar and loss, and get_briefing for "what needs attention" questions. Every number you state must come from a tool result in this conversation. Never estimate or invent a number.',
        '2. Open a report already filtered. When the user asks to see, open, show or list something, call open_report with the report, the office filters and a view when one fits. If they say "that" or "those" right after you named an office, filter the link to that office. The app shows the link as a button the user clicks (nothing opens by itself), so call it "the button" (no above/below) and do not paste URLs.',
        '3. Explain what a report shows, where to find something, or what a term means.',
        'For reports without query_report numbers, say you cannot read those numbers yet and offer the link.',
        '',
        'Office hierarchy (canonical names; use exactly these in tool inputs):',
        offices,
        'The three regions are Malda, Uttar Dinajpur and Dakshin Dinajpur. The Uttar Dinajpur region used to be called the Raiganj region and the Dakshin Dinajpur region the Balurghat region, and some officers still say so: "Raiganj region" means Uttar Dinajpur, "Balurghat region" means Dakshin Dinajpur. Always write the region under its current name (Uttar Dinajpur, Dakshin Dinajpur) in answers and tool inputs. Raiganj and Balurghat are still the names of a division and a CCC inside those regions, and Malda is a region, a division and a CCC: when the user says only "Raiganj", "Balurghat" or "Malda", choose the level that fits the question (usually the division) and say which one you used.',
        '',
        'Reports:',
        reports,
        '',
        `Terms: ${glossary}.`,
        '',
        'How to answer:',
        '- Lead with the answer in one or two short sentences, then at most a few short bullet points if they help. Plain words, no jargon the user did not use, no emojis, no tables.',
        '- Write numbers the Indian way (1,23,456; ₹4.5 L; ₹2.1 Cr). Say which office and date the numbers are for.',
        '- If a tool result says the user only sees part of the zone, answer for that part and mention it once.',
        '- If the question is unclear, ask one short question instead of guessing.',
        '- If something is outside these reports, say so briefly.'
    ].join('\n');
}

function assistantTools(C) {
    const office = (desc) => ({ type: 'string', description: desc });
    const allViews = [];
    C.REPORTS.forEach((r) => Object.keys(r.views || {}).forEach((v) => { if (allViews.indexOf(v) === -1) allViews.push(v); }));
    const dataReports = C.REPORTS.filter((r) => r.data).map((r) => r.key);
    // Inputs are validated in the browser before a tool runs (unknown reports/views are rejected there).
    return [
        {
            name: 'open_report',
            description: 'Give the user a button that opens a report with filters applied. Use when the user wants to see, open, show or list something. Only use filters and views the report supports (see the report list); leave a field out when it does not apply.',
            input_schema: {
                type: 'object',
                properties: {
                    report: { type: 'string', enum: C.REPORTS.map((r) => r.key) },
                    region: office('Region name'),
                    division: office('Division name'),
                    ccc: office('CCC name'),
                    view: { type: 'string', enum: allViews, description: 'A preset view of that report' },
                    search: { type: 'string', description: 'Application / consumer number or name to search for' },
                    label: { type: 'string', description: 'Short button text, e.g. "Uttar Dinajpur · pending over 30 days"' }
                },
                required: ['report', 'label'],
                additionalProperties: false
            }
        },
        {
            name: 'query_report',
            description: 'Count and summarise a report from the data already loaded in the user\'s browser (limited to the user\'s office scope). Returns totals and, with group_by, one row per office. nsc views: over_30_days, pole_cases, rescued_from_withheld, industrial, commercial_three_phase. load_extension views: over_1_year, industrial, three_phase, above_10kw. solar views: connected, pending, meter_issue, pm_surya_ghar. loss has no views; month is YYYY-MM (leave out for the latest).',
            input_schema: {
                type: 'object',
                properties: {
                    report: { type: 'string', enum: dataReports },
                    region: office('Region name'),
                    division: office('Division name'),
                    ccc: office('CCC name'),
                    view: { type: 'string', enum: allViews, description: 'Only count rows in this view' },
                    group_by: { type: 'string', enum: ['none', 'region', 'division', 'ccc'] },
                    month: { type: 'string', description: 'loss only: YYYY-MM' }
                },
                required: ['report', 'group_by'],
                additionalProperties: false
            }
        },
        {
            name: 'get_briefing',
            description: 'Get today\'s zone briefing: items needing attention (critical, high priority, watch) with their numbers and the most affected divisions.',
            input_schema: { type: 'object', properties: {}, additionalProperties: false }
        }
    ];
}

module.exports = { assistantSystemPrompt, assistantTools };
