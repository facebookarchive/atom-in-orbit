'use strict';

// TODO(mbolin): Call this verification code. Having strong verification checks
// will likely help end-users avoid problems when trying to build from source.

const config = require('./config');

// Verify that ATOM_SRC exists and is at revision ATOM_REVISION.
// Should also verify that ./scripts/build has been run.
