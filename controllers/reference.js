// Static reference-data controller: military bases and nation boundaries.
const fs = require('fs');
const path = require('path');

let basesCache = null;
function loadBases() {
    if (basesCache) return basesCache;
    const file = path.join(__dirname, '..', 'datasets', 'bases.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    basesCache = raw.bases || [];
    return basesCache;
}

exports.getBases = function (req, res) {
    const bases = loadBases();
    const q = (req.query.country || '').toLowerCase();
    const t = (req.query.type || '').toLowerCase();
    const filtered = bases.filter(b =>
        (!q || (b.country || '').toLowerCase().includes(q) || (b.iso2 || '').toLowerCase() === q) &&
        (!t || (b.type || '') === t)
    );
    res.json({ count: filtered.length, bases: filtered });
};
