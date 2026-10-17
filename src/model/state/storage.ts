
/** Where the editor keeps what it remembers in this browser, under the app's own names. */
export const MODEL_KEY = 'conceptweaver:model:v1';

export const THEME_KEY = 'conceptweaver:theme';

/** Which saved model the working copy belongs to, and whether it has changes not yet saved there. */
export const DOC_KEY = 'conceptweaver:doc';

export const AUTOSAVE_KEY = 'conceptweaver:autosave';

/** A stored setting, also looked for under the app's former name so that nothing saved before the rename is lost. */
export const stored = (key: string) => localStorage.getItem(key) ?? localStorage.getItem(key.replace('conceptweaver:', 'termloom:'));

export const STYLES_KEY = 'conceptweaver:graph-styles';

/** The language entity names and descriptions are shown in. Empty: the model's own language. */
export const DISPLAY_LANG_KEY = 'conceptweaver:display-lang';
