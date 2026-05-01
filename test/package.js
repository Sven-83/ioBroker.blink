'use strict';
const { tests } = require('@iobroker/testing');

// Run package tests
tests.packageFiles(__dirname, {
    allowedExtraFiles: [
        'blink-dashboard.html',
        'docs/**',
    ],
});
