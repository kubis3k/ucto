// Tenký klient (Varianta A, 2026-07-09): appka se teď načítá přímo z webové
// domény (main.js loadURL), takže "/api" je SAME-ORIGIN — index.html si ho
// spočítá sám (viz inline bootstrap skript), preload nemá co přepisovat.
// Soubor zůstává (webPreferences.preload ho čeká), ale je záměrně prázdný.
