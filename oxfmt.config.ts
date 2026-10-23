import preset from '@pebbletech/config/oxfmt.json' with { type: 'json' };

// oxfmt has no `extends`; a product spreads the preset and adds its own import groups.
// This repo has no path aliases, so it takes the preset as is.
export default preset;
