import { Button, WorkspaceHero } from '@shop/design';
import { Button as SelectButton, Label, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';
import type { CockpitPeriod } from './CockpitQuery';

export interface CockpitHeroProps {
  readonly perspective?: Readonly<{ name: string; channel: string }>;
  readonly period: CockpitPeriod;
  readonly busy?: boolean;
  readonly onPeriodChange: (period: CockpitPeriod) => void;
  readonly onRefresh: () => void;
}

export function CockpitHero({ perspective, period, busy, onPeriodChange, onRefresh }: CockpitHeroProps) {
  return (
    <WorkspaceHero className="cockpithero" title={perspective === undefined ? '生意看板' : `${perspective.name}生意看板`}
      description={perspective === undefined ? '今天卖了多少、还有什么要处理，一眼看清。'
        : `${perspective.channel} · 只看当前供应商的销售、履约与结算结果。`}
      actions={<><Select className="cockpitperiodfield" selectedKey={period}
        onSelectionChange={(key) => { if (key !== null) onPeriodChange(key as CockpitPeriod); }}>
        <Label>统计周期</Label>
        <SelectButton className="cockpitperiodtrigger"><SelectValue />
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
        </SelectButton>
        <Popover className="cockpitperiodpopover" placement="bottom end" offset={6}>
          <ListBox className="cockpitperiodoptions">
            <ListBoxItem id="realtime" textValue="今天">今天</ListBoxItem>
            <ListBoxItem id="yesterday" textValue="昨日">昨日</ListBoxItem>
            <ListBoxItem id="7days" textValue="近 7 日">近 7 日</ListBoxItem>
            <ListBoxItem id="30days" textValue="近 30 日">近 30 日</ListBoxItem>
          </ListBox>
        </Popover>
      </Select><Button className="cockpitrefresh" onPress={onRefresh}>{busy ? '正在刷新' : '刷新数据'}</Button></>} />
  );
}
