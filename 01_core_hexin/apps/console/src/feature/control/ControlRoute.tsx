import { ResourceState } from '@shop/design';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useConsoleContext } from '../../entity/session/ConsoleContext';
import { queryCondition, safeQueryError } from '../../shared/api/QueryState';
import { CapabilityChain } from './CapabilityChain';
import { ActiveChange, AuditTimeline } from './ControlChanges';
import { AuditDialog, ChangeDialog, EvidenceDialog, RecoveryDialog } from './ControlDialogs';
import { ControlHero } from './ControlHero';
import { controlKey, readControl } from './ControlQuery';
import type { ControlChange, ControlIncident } from './ControlSchema';
import { IncidentQueue } from './IncidentQueue';
import './control.css';

export function Component() {
  const context = useConsoleContext();
  const query = useQuery({ queryKey: controlKey(context), queryFn: ({ signal }) => readControl(context, signal) });
  const plane = query.data?.controlPlane;
  const [selectedId, setSelectedId] = useState<string>();
  const selectedIncident = plane?.incidents.find(({ id }) => id === selectedId) ?? plane?.incidents[0];
  const [evidence, setEvidence] = useState<ControlIncident>();
  const [recovery, setRecovery] = useState<ControlIncident>();
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [changeAction, setChangeAction] = useState<'plan' | 'pause' | 'rollback'>();
  const [change, setChange] = useState<ControlChange>();
  const [auditOpen, setAuditOpen] = useState(false);
  const error = safeQueryError(query.error);
  const condition = queryCondition({
    pending: query.isPending,
    fetching: query.isFetching,
    error: query.error,
    hasData: plane !== undefined,
    empty: plane === undefined,
    stale: query.isStale,
  });

  const openRecovery = (incident: ControlIncident) => {
    setRecoveryConfirmed(false);
    setRecovery(incident);
  };
  const closeRecovery = () => {
    setRecovery(undefined);
    setRecoveryConfirmed(false);
  };
  const openChange = (action: 'plan' | 'pause' | 'rollback', value: ControlChange) => {
    setChangeAction(action);
    setChange(value);
  };

  return (
    <section className="controlpage">
      <ResourceState condition={condition} resourceLabel="主打团 中控台"
        {...(error === undefined ? {} : { error })} retry={() => { void query.refetch(); }}>
        <div>
          <ControlHero plane={plane} refreshing={query.isFetching} onRefresh={() => { void query.refetch(); }} />
          <div className="controlworkspace">
            <div className="controlprimarygrid">
              <IncidentQueue incidents={plane?.incidents ?? []} selectedId={selectedIncident?.id}
                onSelect={(incident) => setSelectedId(incident.id)} onEvidence={setEvidence} onExecute={openRecovery} />
              <CapabilityChain capabilities={plane?.capabilities ?? []}
                affected={selectedIncident?.affectedCapabilities ?? []} />
            </div>
            <div className="controlsecondarygrid">
              <ActiveChange change={plane?.changes[0]} onAction={openChange} />
              <AuditTimeline audits={plane?.audits ?? []} onOpen={() => setAuditOpen(true)} />
            </div>
          </div>
        </div>
      </ResourceState>
      <EvidenceDialog incident={evidence} onClose={() => setEvidence(undefined)} />
      <RecoveryDialog incident={recovery} confirmed={recoveryConfirmed}
        onConfirm={() => setRecoveryConfirmed(true)} onClose={closeRecovery} />
      <ChangeDialog action={changeAction} change={change}
        onClose={() => { setChangeAction(undefined); setChange(undefined); }} />
      <AuditDialog open={auditOpen} audits={plane?.audits ?? []} onClose={() => setAuditOpen(false)} />
    </section>
  );
}
