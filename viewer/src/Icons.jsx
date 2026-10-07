// Minimal stroke icons (16px), drawn for this app so they match the type weight.
const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
const I = (d) => (props) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...props}><g {...P}>{d}</g></svg>
);
export const IconOrbit = I(<><ellipse cx="8" cy="8" rx="6.5" ry="2.8" /><circle cx="8" cy="8" r="1.6" /></>);
export const IconRuler = I(<><path d="M2 11.5 11.5 2l2.5 2.5L4.5 14z" /><path d="M5 9l1.2 1.2M7 7l1.2 1.2M9 5l1.2 1.2" /></>);
export const IconScale = I(<><path d="M2.5 13.5h11M4 13.5V7M12 13.5V4" /><path d="M2.5 7h3M10.5 4h3" /></>);
export const IconCamera = I(<><rect x="1.5" y="4.5" width="9.5" height="7" rx="1.2" /><path d="m11 7 3.5-2v6L11 9" /></>);
export const IconPlan = I(<><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 8h5V2M7 14v-3h7" /></>);
export const IconOverview = I(<><path d="M8 2 14 5.5v5L8 14 2 10.5v-5z" /><path d="M2 5.5 8 9l6-3.5M8 9v5" /></>);
export const IconLayers = I(<><path d="M8 2 14.5 5.5 8 9 1.5 5.5z" /><path d="m1.5 8.5 6.5 3.5 6.5-3.5" /></>);
export const IconExport = I(<><path d="M8 10V2M5 5l3-3 3 3" /><path d="M2.5 9.5v3.5h11V9.5" /></>);
export const IconHelp = I(<><circle cx="8" cy="8" r="6.5" /><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.4" /><circle cx="8" cy="11.6" r=".4" fill="currentColor" /></>);
export const IconPresent = I(<><rect x="1.5" y="2.5" width="13" height="8.5" rx="1" /><path d="M8 11v2.5M5 14h6" /><path d="m6.5 5 3 1.8-3 1.8z" fill="currentColor" /></>);
export const IconChevron = I(<path d="m10 3-5 5 5 5" />);
export const IconClose = I(<path d="m4 4 8 8M12 4l-8 8" />);
export const IconShield = I(<><path d="M8 1.8 13.5 4v4c0 3.2-2.4 5.4-5.5 6.2C4.9 13.4 2.5 11.2 2.5 8V4z" /><path d="m5.6 8 1.7 1.7 3.2-3.4" /></>);
