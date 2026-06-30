/**
 * MZO Presets Hub - Shared Library
 * Manages Global Jurisdiction & Page-Specific Filter Presets in localStorage.
 * Supports automated setup modals and dynamic multi-dashboard synchronization.
 */
(function(window) {
    'use strict';

    const STORAGE_KEY_GLOBAL = 'mzo_global_jurisdiction';
    const STORAGE_KEY_PRESETS = 'mzo_filter_presets_v1';

    const MzoPresetsHub = {
        /**
         * Get current global jurisdiction preference
         */
        getGlobalJurisdiction: function() {
            try {
                const data = localStorage.getItem(STORAGE_KEY_GLOBAL);
                return data ? JSON.parse(data) : null;
            } catch(e) {
                console.error("MzoPresetsHub: Error reading global jurisdiction", e);
                return null;
            }
        },

        /**
         * Save global jurisdiction preference
         */
        setGlobalJurisdiction: function(region, division, ccc) {
            try {
                const pref = {
                    region: region || 'all',
                    division: division || 'all',
                    ccc: ccc || 'all',
                    updatedAt: new Date().toISOString()
                };
                localStorage.setItem(STORAGE_KEY_GLOBAL, JSON.stringify(pref));
                console.log("MzoPresetsHub: Global jurisdiction updated", pref);
                return pref;
            } catch(e) {
                console.error("MzoPresetsHub: Error saving global jurisdiction", e);
                return null;
            }
        },

        /**
         * Clear global jurisdiction preference
         */
        clearGlobalJurisdiction: function() {
            try {
                localStorage.removeItem(STORAGE_KEY_GLOBAL);
            } catch(e) {}
        },

        /**
         * Get all saved presets
         */
        getPresets: function() {
            try {
                const data = localStorage.getItem(STORAGE_KEY_PRESETS);
                return data ? JSON.parse(data) : [];
            } catch(e) {
                return [];
            }
        },

        /**
         * Save a new preset
         */
        savePreset: function(name, pageName, filterObj, isGlobalDefault = false) {
            try {
                const presets = this.getPresets();
                const newPreset = {
                    id: 'preset_' + Date.now(),
                    name: name,
                    pageName: pageName || 'global',
                    filters: filterObj,
                    isGlobalDefault: isGlobalDefault,
                    createdAt: new Date().toISOString()
                };
                
                if (isGlobalDefault && filterObj) {
                    this.setGlobalJurisdiction(filterObj.region, filterObj.division, filterObj.ccc);
                }

                presets.push(newPreset);
                localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(presets));
                return newPreset;
            } catch(e) {
                console.error("MzoPresetsHub: Error saving preset", e);
                return null;
            }
        },

        /**
         * Delete a preset by ID
         */
        deletePreset: function(id) {
            try {
                let presets = this.getPresets();
                presets = presets.filter(p => p.id !== id);
                localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(presets));
            } catch(e) {}
        },

        /**
         * Helper to apply saved preferences to DOM elements on a given page.
         * Automatically matches common element ID patterns and varied naming across different HTML pages.
         */
        applyToPage: function(opts = {}) {
            if (this._isApplying) return false;
            this._isApplying = true;

            try {
                const globalPref = this.getGlobalJurisdiction();
                if (!globalPref) return false;

                const shouldTrigger = (opts.triggerChange !== false);
                let applied = false;

                function isMatch(savedName, optionValue) {
                    if (!savedName || !optionValue || savedName === 'all' || optionValue === 'all') return false;
                    const s = String(savedName).toLowerCase().replace(/region|division|div|total/g, '').trim();
                    const o = String(optionValue).toLowerCase().replace(/region|division|div|total/g, '').trim();
                    if (!s || !o) return false;
                    
                    if (s.includes('uttar') || s.includes('u/dinajpur')) {
                        return o.includes('uttar') || o.includes('u/dinajpur') || o.includes('u_dinajpur');
                    }
                    if (s.includes('dakshin') || s.includes('d/dinajpur')) {
                        return o.includes('dakshin') || o.includes('d/dinajpur') || o.includes('d_dinajpur');
                    }
                    return s.includes(o) || o.includes(s);
                }

                function findElement(ids) {
                    for (let id of ids) {
                        const el = document.getElementById(id);
                        if (el) return el;
                    }
                    return null;
                }

                // 1. Check for standard Region select IDs
                const regionIDs = ['regionFilter', 'regionSelect', 'locationFilter', 'region', 'region-filter'];
                let regionEl = null;
                for (let id of regionIDs) {
                    const el = document.getElementById(id);
                    if (el) { regionEl = el; break; }
                }

                if (regionEl && globalPref.region && globalPref.region !== 'all') {
                    for (let opt of regionEl.options) {
                        if (isMatch(globalPref.region, opt.value)) {
                            if (regionEl.value !== opt.value) {
                                regionEl.value = opt.value;
                                if (shouldTrigger) regionEl.dispatchEvent(new Event('change'));
                                applied = true;
                            }
                            break;
                        }
                    }
                }

                // 2. Check for standard Division select IDs
                const divisionIDs = ['divisionFilter', 'divisionSelect', 'divnSelect', 'division', 'division-filter'];
                let divisionEl = null;
                for (let id of divisionIDs) {
                    const el = document.getElementById(id);
                    if (el) { divisionEl = el; break; }
                }

                if (divisionEl && globalPref.division && globalPref.division !== 'all') {
                    for (let opt of divisionEl.options) {
                        if (isMatch(globalPref.division, opt.value)) {
                            if (divisionEl.value !== opt.value) {
                                divisionEl.value = opt.value;
                                if (shouldTrigger) divisionEl.dispatchEvent(new Event('change'));
                                applied = true;
                            }
                            break;
                        }
                    }
                }

                // 3. Check for standard CCC / Unit select IDs
                const cccIDs = ['cccFilter', 'cccSelect', 'unitFilter', 'suppSelect', 'support', 'ccc-filter'];
                let cccEl = null;
                for (let id of cccIDs) {
                    const el = document.getElementById(id);
                    if (el) { cccEl = el; break; }
                }

                if (cccEl && globalPref.ccc && globalPref.ccc !== 'all') {
                    for (let opt of cccEl.options) {
                        if (isMatch(globalPref.ccc, opt.value)) {
                            if (cccEl.value !== opt.value) {
                                cccEl.value = opt.value;
                                if (shouldTrigger) cccEl.dispatchEvent(new Event('change'));
                                applied = true;
                            }
                            break;
                        }
                    }
                }

                // 4. Check for unified single office filter (like on index.html #executiveOfficeFilter or loss.html #cccFilter)
                const hasMultipleOfficeFilters = !!(findElement(regionIDs) || findElement(divisionIDs));
                const execEl = document.getElementById('executiveOfficeFilter') || (!hasMultipleOfficeFilters ? findElement(cccIDs) : null);
                if (execEl) {
                    let matched = false;
                    if (globalPref.ccc && globalPref.ccc !== 'all') {
                        for (let opt of execEl.options) {
                            if (isMatch(globalPref.ccc, opt.value)) {
                                if (execEl.value !== opt.value) {
                                    execEl.value = opt.value;
                                    if (shouldTrigger) execEl.dispatchEvent(new Event('change'));
                                    applied = true;
                                }
                                matched = true;
                                break;
                            }
                        }
                    }
                    if (!matched && globalPref.division && globalPref.division !== 'all') {
                        for (let opt of execEl.options) {
                            if (isMatch(globalPref.division, opt.value)) {
                                if (execEl.value !== opt.value) {
                                    execEl.value = opt.value;
                                    if (shouldTrigger) execEl.dispatchEvent(new Event('change'));
                                    applied = true;
                                }
                                matched = true;
                                break;
                            }
                        }
                    }
                    if (!matched && globalPref.region && globalPref.region !== 'all') {
                        for (let opt of execEl.options) {
                            if (isMatch(globalPref.region, opt.value)) {
                                if (execEl.value !== opt.value) {
                                    execEl.value = opt.value;
                                    if (shouldTrigger) execEl.dispatchEvent(new Event('change'));
                                    applied = true;
                                }
                                break;
                            }
                        }
                    }
                }

                return applied;
            } finally {
                this._isApplying = false;
            }
        },

        /**
         * Render interactive Setup Modal Dialog dynamically (Self-contained, no external JS framework needed)
         */
        showSetupModal: function(opts, callback) {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }
            opts = opts || {};

            let modalEl = document.getElementById('mzoPresetModal');
            if (modalEl) modalEl.remove();

            const globalPref = this.getGlobalJurisdiction() || {};
            const showCCC = !!opts.showCCC;
            const cccList = opts.cccList || [];

            const cccHtml = showCCC ? `
                        <div id="mzoModalCccContainer" style="margin-bottom:16px;">
                            <label style="display:block; font-size:12px; font-weight:600; margin-bottom:6px; color:#334155;">Managing CCC</label>
                            <select id="mzoModalCCC" style="width:100%; padding:8px 10px; font-size:13px; border:1px solid #cbd5e1; border-radius:8px; outline:none; background:#ffffff; color:#0f172a;">
                                <option value="all">All CCCs</option>
                            </select>
                        </div>
            ` : '';

            const html = `
            <div id="mzoPresetModal" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); z-index:100050; display:flex; align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                <div style="background:#ffffff; width:90%; max-width:440px; border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,0.3); overflow:hidden;">
                    <div style="background:#1d4ed8; color:#ffffff; padding:16px 20px; display:flex; align-items:center; justify-content:space-between;">
                        <h3 style="margin:0; font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; color:#ffffff;"><i class="fas fa-cog"></i> Office Preferences</h3>
                        <button type="button" id="mzoModalCloseBtn" style="background:none; border:none; color:#ffffff; font-size:22px; cursor:pointer; line-height:1;">&times;</button>
                    </div>
                    <div style="padding:20px; color:#1e293b;">
                        <p style="margin:0 0 16px 0; font-size:13px; color:#64748b; line-height:1.4;">Save your managing jurisdiction below. Dashboards will automatically pre-filter to your jurisdiction every time you open the app.</p>
                        
                        <div style="margin-bottom:14px;">
                            <label style="display:block; font-size:12px; font-weight:600; margin-bottom:6px; color:#334155;">Managing Region</label>
                            <select id="mzoModalRegion" style="width:100%; padding:8px 10px; font-size:13px; border:1px solid #cbd5e1; border-radius:8px; outline:none; background:#ffffff; color:#0f172a;">
                                <option value="all">All Regions</option>
                                <option value="MALDA REGION">MALDA REGION</option>
                                <option value="UTTAR DINAJPUR REGION">UTTAR DINAJPUR REGION</option>
                                <option value="DAKSHIN DINAJPUR REGION">DAKSHIN DINAJPUR REGION</option>
                            </select>
                        </div>

                        <div style="margin-bottom:16px;">
                            <label style="display:block; font-size:12px; font-weight:600; margin-bottom:6px; color:#334155;">Managing Division</label>
                            <select id="mzoModalDivision" style="width:100%; padding:8px 10px; font-size:13px; border:1px solid #cbd5e1; border-radius:8px; outline:none; background:#ffffff; color:#0f172a;">
                                <option value="all">All Divisions</option>
                                <option value="MALDA DIVISION">MALDA DIVISION</option>
                                <option value="CHANCHAL DIVISION">CHANCHAL DIVISION</option>
                                <option value="GAZOLE DIVISION">GAZOLE DIVISION</option>
                                <option value="RAIGANJ DIVISION">RAIGANJ DIVISION</option>
                                <option value="ISLAMPUR DIVISION">ISLAMPUR DIVISION</option>
                                <option value="BALURGHAT DIVISION">BALURGHAT DIVISION</option>
                                <option value="BUNIADPUR DIVISION">BUNIADPUR DIVISION</option>
                            </select>
                        </div>

                        ${cccHtml}

                        <div style="display:flex; align-items:center; gap:8px; margin-top:16px;">
                            <input type="checkbox" id="mzoModalSetGlobal" checked style="width:16px; height:16px; cursor:pointer;">
                            <label for="mzoModalSetGlobal" style="font-size:12px; font-weight:500; color:#334155; cursor:pointer;">Set as default preference for ALL dashboards</label>
                        </div>
                    </div>
                    <div style="background:#f8fafc; padding:12px 20px; display:flex; align-items:center; justify-content:flex-end; gap:10px; border-top:1px solid #e2e8f0;">
                        <button type="button" id="mzoModalCancelBtn" style="background:#ffffff; border:1px solid #cbd5e1; color:#475569; padding:6px 14px; border-radius:6px; font-size:12px; font-weight:500; cursor:pointer;">Cancel</button>
                        <button type="button" id="mzoModalSaveBtn" style="background:#1d4ed8; border:none; color:#ffffff; padding:6px 18px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">Save Preference</button>
                    </div>
                </div>
            </div>`;

            document.body.insertAdjacentHTML('beforeend', html);

            const modalTarget = document.getElementById('mzoPresetModal');
            const regEl = document.getElementById('mzoModalRegion');
            const divEl = document.getElementById('mzoModalDivision');
            const cccEl = document.getElementById('mzoModalCCC');

            if (globalPref.region) regEl.value = globalPref.region;
            if (globalPref.division) divEl.value = globalPref.division;

            function updateModalCCCs() {
                if (!cccEl) return;
                const selectedReg = regEl.value;
                const selectedDiv = divEl.value;

                function matchesRegion(prefReg, cccReg) {
                    if (!prefReg || prefReg === 'all') return true;
                    if (!cccReg) return false;
                    const r = prefReg.toLowerCase().replace(/region/g, '').trim();
                    const c = String(cccReg).toLowerCase().replace(/region/g, '').trim();
                    if (r === 'ud' || r.includes('uttar') || r.includes('u/dinajpur')) {
                        return c === 'ud' || c.includes('uttar') || c.includes('u/dinajpur') || c.includes('u_dinajpur');
                    }
                    if (r === 'dd' || r.includes('dakshin') || r.includes('d/dinajpur')) {
                        return c === 'dd' || c.includes('dakshin') || c.includes('d/dinajpur') || c.includes('d_dinajpur');
                    }
                    return r.includes(c) || c.includes(r);
                }

                function matchesDivision(prefDiv, cccDiv) {
                    if (!prefDiv || prefDiv === 'all') return true;
                    if (!cccDiv) return false;
                    const d = prefDiv.toLowerCase().replace(/division|div/g, '').trim();
                    const c = String(cccDiv).toLowerCase().replace(/division|div/g, '').trim();
                    return d.includes(c) || c.includes(d);
                }

                const filteredCCCs = cccList.filter(item => {
                    return matchesRegion(selectedReg, item.region) && matchesDivision(selectedDiv, item.division);
                });

                const prevVal = cccEl.value || String(globalPref.ccc || 'all');
                cccEl.innerHTML = '<option value="all">All CCCs</option>';
                filteredCCCs.forEach(item => {
                    const opt = document.createElement('option');
                    opt.value = item.code;
                    opt.textContent = item.name;
                    cccEl.appendChild(opt);
                });

                if (Array.from(cccEl.options).some(o => o.value == prevVal)) {
                    cccEl.value = prevVal;
                } else {
                    cccEl.value = 'all';
                }
            }

            if (showCCC && cccEl) {
                updateModalCCCs();
                if (globalPref.ccc) {
                    cccEl.value = globalPref.ccc;
                }
                regEl.addEventListener('change', updateModalCCCs);
                divEl.addEventListener('change', updateModalCCCs);
            }

            const closeModal = () => { if (modalTarget) modalTarget.remove(); };

            document.getElementById('mzoModalCloseBtn').addEventListener('click', closeModal);
            document.getElementById('mzoModalCancelBtn').addEventListener('click', closeModal);

            document.getElementById('mzoModalSaveBtn').addEventListener('click', () => {
                const selectedRegion = regEl.value;
                const selectedDivision = divEl.value;
                const selectedCCC = showCCC && cccEl ? cccEl.value : 'all';
                const isGlobal = document.getElementById('mzoModalSetGlobal').checked;

                if (isGlobal) {
                    MzoPresetsHub.setGlobalJurisdiction(selectedRegion, selectedDivision, selectedCCC);
                }
                
                closeModal();
                if (typeof callback === 'function') callback({ region: selectedRegion, division: selectedDivision, ccc: selectedCCC });
            });
        }
    };

    window.mzoPresetsHub = MzoPresetsHub;
})(window);
