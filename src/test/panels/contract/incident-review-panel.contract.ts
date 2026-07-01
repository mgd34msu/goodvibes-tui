import { IncidentReviewPanel } from '../../../panels/incident-review-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

runBasePanelContractSuite({
  label: 'IncidentReviewPanel (no registry)',
  factory: () => new IncidentReviewPanel(),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
