import { useMemo } from 'react';
import type { DataColumn } from '../../shared/ui/DataTable';
import { DataTable } from '../../shared/ui/DataTable';
import { formatDate } from '../../shared/ui/Format';
import { applicationStatusLabel, applicationStatusTone, publicationLabel, validationLabel, validationTone } from './ApplicationPresentation';
import type { Application } from './ApplicationSchema';
import type { CommerceWorkspaceMode } from './ApplicationScope';

export function ApplicationTable({
  rows,
  mode,
  canEdit,
  canCopy,
  onEnter,
  onOpen,
  onEdit,
  onCopy,
  onDisable,
}: Readonly<{
  rows: readonly Application[];
  mode: CommerceWorkspaceMode;
  canEdit: boolean;
  canCopy: boolean;
  onEnter: (record: Application) => void;
  onOpen: (record: Application) => void;
  onEdit: (record: Application) => void;
  onCopy: (record: Application) => void;
  onDisable: (record: Application) => void;
}>) {
  const columns = useMemo(() => applicationColumns(mode, { canEdit, canCopy, onEnter, onOpen, onEdit, onCopy, onDisable }), [canCopy, canEdit, mode, onCopy, onDisable, onEdit, onEnter, onOpen]);
  return <DataTable caption={tableCaption(mode)} columns={columns} rows={rows} rowKey={(row) => row.id} />;
}

interface ApplicationActions {
  readonly canEdit: boolean;
  readonly canCopy: boolean;
  readonly onEnter: (record: Application) => void;
  readonly onOpen: (record: Application) => void;
  readonly onEdit: (record: Application) => void;
  readonly onCopy: (record: Application) => void;
  readonly onDisable: (record: Application) => void;
}

function applicationColumns(mode: CommerceWorkspaceMode, actions: ApplicationActions): readonly DataColumn<Application>[] {
  return Object.freeze([
    {
      key: 'identity',
      label: mode === 'design' ? '当前店铺应用' : '商城 / 应用',
      render: (row) => (
        <div className="commerceidentity">
          <span className="commerceappmark" aria-hidden="true">
            店
          </span>
          <span>
            <button type="button" onClick={() => actions.onOpen(row)} aria-label={`查看${row.name}摘要`}>
              {row.name}
            </button>
            <code>{row.code}</code>
          </span>
        </div>
      ),
    },
    {
      key: 'binding',
      label: '商城 / 商品池',
      render: (row) => (
        <div className="commercebinding">
          <span>{row.mall_id ?? '未绑定商城'}</span>
          <code>{row.pool_id ?? '未绑定商品池'}</code>
        </div>
      ),
    },
    {
      key: 'draft',
      label: '装修草稿',
      render: (row) => (
        <div className="commerceversion">
          <strong>{row.head_sequence === null || row.head_sequence === undefined ? '—' : `v${row.head_sequence}`}</strong>
          <span className={`commercestate is-${validationTone(row.head_validation_state)}`}>
            <i aria-hidden="true" />
            {validationLabel(row.head_validation_state)}
          </span>
        </div>
      ),
    },
    {
      key: 'publication',
      label: '发布 / 域名',
      render: (row) => (
        <div className="commercepublication">
          <strong>{publicationLabel(row)}</strong>
          <span>{storefrontDomain(row.domain)}</span>
        </div>
      ),
    },
    {
      key: 'status',
      label: '经营状态',
      render: (row) => (
        <span className={`commercestate is-${applicationStatusTone(row.status)}`}>
          <i aria-hidden="true" />
          {applicationStatusLabel(row.status)}
        </span>
      ),
    },
    { key: 'updated', label: '更新时间', render: (row) => <time>{formatDate(row.updated_at)}</time> },
    {
      key: 'action',
      label: '操作',
      render: (row) => (
        <div className="commercebinding">
          {row.mall_id === null || row.mall_id === undefined ? null : (
            <button className="commercerowaction" type="button" onClick={() => actions.onEnter(row)} aria-label={`进入${row.name}后台`}>
              进入后台
            </button>
          )}
          <button className="commercerowaction" type="button" onClick={() => actions.onOpen(row)} aria-label={`查看${row.name}`}>
            查看
          </button>
          {actions.canEdit ? (
            <button className="commercerowaction" type="button" onClick={() => actions.onEdit(row)} aria-label={`编辑${row.name}`}>
              编辑
            </button>
          ) : null}
          {actions.canCopy ? (
            <button className="commercerowaction" type="button" onClick={() => actions.onCopy(row)} aria-label={`复制${row.name}`}>
              复制
            </button>
          ) : null}
          {actions.canEdit && row.status.toLowerCase() !== 'disabled' ? (
            <button className="commercerowaction" type="button" onClick={() => actions.onDisable(row)} aria-label={`停用${row.name}`}>
              停用
            </button>
          ) : null}
        </div>
      ),
    },
  ]);
}

function storefrontDomain(domain: string | null | undefined): string {
  if (domain === null || domain === undefined) return '域名未绑定';
  return /^h\d+$/.test(domain) ? `${domain}（入口编号）` : domain;
}

function tableCaption(mode: CommerceWorkspaceMode): string {
  if (mode === 'governance') return '应用治理列表';
  if (mode === 'design') return '店铺装修应用';
  return '商城列表';
}
