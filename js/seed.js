/* Neutral defaults only. No personal data is stored in the code.
   Load your own history with Settings -> Import (JSON backup or text log). */
(function (root) {
  'use strict';
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  const DEFAULTS = {
    title: 'Ode to Minecraft',
    subtitle: 'Digital Fasting',
    goal: 5300,
    startDate: today,            // Day 1 (an import can change this)
    openingBalance: 0,
    goodDay: 60,
    autoLockMin: 5,
    lockToday: false,
    rules: [
      'No YouTube unless told so',
      'No Geometry Dash or Block Blast unless told so',
      'No Jigidi unless told so',
      'Using a device for homework, listening to music, learning and useful videos is allowed.'
    ],
    milestones: [500, 1000, 2000, 3000, 4000, 5300]
  };

  const CORRECTIONS = [];
  function seedEntries() { return []; }

  const api = { DEFAULTS, CORRECTIONS, seedEntries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Seed = api;
})(typeof window !== 'undefined' ? window : globalThis);
