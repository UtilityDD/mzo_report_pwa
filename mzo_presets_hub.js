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
                    const s = savedName.toLowerCase().replace(/region|division|div|total/g, '').trim();
                    const o = optionValue.toLowerCase().replace(/region|division|div|total/g, '').trim();
                    if (!s || !o) return false;
                    
                    if (s.includes('uttar') || s.includes('u/dinajpur')) {
                        return o.includes('uttar') || o.includes('u/dinajpur') || o.includes('u_dinajpur');
                    }
                    if (s.includes('dakshin') || s.includes('d/dinajpur')) {
                        return o.includes('dakshin') || o.includes('d/dinajpur') || o.includes('d_dinajpur');
                    }
                    return s.includes(o) || o.includes(s);
                }

                // 1. Check for standard Region select IDs
                const regionIDs = ['regionFilter', 'regionSelect', 'locationFilter'];
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
                const divisionIDs = ['divisionFilter', 'divisionSelect', 'divnSelect'];
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
                const cccIDs = ['cccFilter', 'cccSelect', 'unitFilter', 'suppSelect'];
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

                // 4. Check for unified single office filter (like on index.html #executiveOfficeFilter)
                const execEl = document.getElementById('executiveOfficeFilter');
                if (execEl) {
                    let matched = false;
                    if (globalPref.division && globalPref.division !== 'all') {
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
         * Render interactive Setup Modal Dialog dynamically
         */
        showSetupModal: function(callback) {
            let modalEl = document.getElementById('mzoPresetModal');
            if (modalEl) modalEl.remove();

            const globalPref = this.getGlobalJurisdiction() || {};

            const html = `
            <div class="modal fade" id="mzoPresetModal" tabindex="-1" aria-hidden="true" style="z-index:10050;">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content border-0 shadow-lg" style="border-radius:16px;">
                        <div class="modal-header bg-primary text-white py-3 px-4" style="border-top-left-radius:16px; border-top-right-radius:16px;">
                            <h5 class="modal-title fw-bold fs-6"><i class="bi bi-gear-fill me-2"></i>Set My Office Jurisdiction Preferences</h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body p-4">
                            <p class="text-secondary small mb-3">Save your managing jurisdiction below. This will automatically pre-filter your dashboards every time you open the app, even when CSV data updates daily.</p>
                            
                            <div class="mb-3">
                                <label class="form-label small fw-semibold">Managing Region</label>
                                <select id="mzoModalRegion" class="form-select form-select-sm">
                                    <option value="all">All Regions</option>
                                    <option value="MALDA REGION">MALDA REGION</option>
                                    <option value="UTTAR DINAJPUR REGION">UTTAR DINAJPUR REGION</option>
                                    <option value="DAKSHIN DINAJPUR REGION">DAKSHIN DINAJPUR REGION</option>
                                </select>
                            </div>

                            <div class="mb-3">
                                <label class="form-label small fw-semibold">Managing Division</label>
                                <select id="mzoModalDivision" class="form-select form-select-sm">
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

                            <div class="form-check form-switch mt-4">
                                <input class="form-check-input" type="checkbox" id="mzoModalSetGlobal" checked>
                                <label class="form-check-label small fw-medium" for="mzoModalSetGlobal">Set as my default preference for ALL report dashboards</label>
                            </div>
                        </div>
                        <div class="modal-footer bg-light py-2 px-4" style="border-bottom-left-radius:16px; border-bottom-right-radius:16px;">
                            <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" id="mzoModalSaveBtn" class="btn btn-primary btn-sm px-3 fw-medium">Save Preference</button>
                        </div>
                    </div>
                </div>
            </div>`;

            document.body.insertAdjacentHTML('beforeend', html);

            const regEl = document.getElementById('mzoModalRegion');
            const divEl = document.getElementById('mzoModalDivision');

            if (globalPref.region) regEl.value = globalPref.region;
            if (globalPref.division) divEl.value = globalPref.division;

            const modalInstance = new bootstrap.Modal(document.getElementById('mzoPresetModal'));
            modalInstance.show();

            document.getElementById('mzoModalSaveBtn').addEventListener('click', () => {
                const selectedRegion = regEl.value;
                const selectedDivision = divEl.value;
                const isGlobal = document.getElementById('mzoModalSetGlobal').checked;

                if (isGlobal) {
                    MzoPresetsHub.setGlobalJurisdiction(selectedRegion, selectedDivision, 'all');
                }
                
                modalInstance.hide();
                if (typeof callback === 'function') callback({ region: selectedRegion, division: selectedDivision });
            });
        }
    };

    window.mzoPresetsHub = MzoPresetsHub;
})(window);
