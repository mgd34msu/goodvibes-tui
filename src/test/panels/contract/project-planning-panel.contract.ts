import { ProjectPlanningPanel } from '../../../panels/project-planning-panel.ts';
import { runBasePanelContractSuite, EMPTY_PROJECT_PLANNING_SERVICE } from './_shared.ts';

runBasePanelContractSuite({
  label: 'ProjectPlanningPanel (no state)',
  factory: () => new ProjectPlanningPanel({
    service: EMPTY_PROJECT_PLANNING_SERVICE,
    projectId: 'proj',
  }),
});
