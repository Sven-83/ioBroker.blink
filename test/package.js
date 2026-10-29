'use strict';
const path = require('path');
const { tests } = require('@iobroker/testing');

// Run package tests
tests.packageFiles(path.join(__dirname, '..'), {
    allowedExtraFiles: [
        'blink-dashboard.html',
        'docs/**',
    ],
});
