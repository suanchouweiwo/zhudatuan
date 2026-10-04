import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Palette, Search } from 'lucide-react';
import { Table } from '../Table';
import { BrandLogo } from './BrandLogo';
import { Button } from './Button';
import { Input } from './Input';
import { Select } from './Select';
import { Checkbox } from './Checkbox';
import { RadioGroup } from './Radio';
import { StatusBadge } from './StatusBadge';
import { Tabs } from './Tabs';
import { MetricCard } from './MetricCard';
import { DataTable, type Column } from './DataTable';
import { Toolbar } from './Toolbar';
import { Drawer } from './Drawer';
import { Modal } from './Modal';
import { ToastProvider, useToast } from './Toast';
import { CommandPalette } from './CommandPalette';
import './ConsoleUI.stories.css';

const meta = {
  title: 'LK Console UI',
  parameters: { layout: 'fullscreen', controls: { disable: true }, a11y: { disable: true } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
type Theme = 'light' | 'dark';
type Density = 'comfortable' | 'compact';

const rows = [
  { id: 'surface', name: '表面层级', description: '卡片、表格与浮层的样式样本', state: '正常样式' },
  { id: 'text', name: '文字层级', description: '主要、次要与辅助文字的样式样本', state: '提示样式' },
  { id: 'border', name: '边框层级', description: '结构边框与交互边框的样式样本', state: '中性样式' },
];
type SampleRow = typeof rows[number];

const columns: Column<SampleRow>[] = [
  { key: 'name', title: '样本名称', render: (row) => <strong>{row.name}</strong> },
  { key: 'description', title: '样本说明' },
  { key: 'state', title: '样式状态', render: (row) => <StatusBadge label={row.state} variant={row.id === 'surface' ? 'success' : row.id === 'text' ? 'info' : 'neutral'} /> },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="console-card p-4 sm:p-6 space-y-4"><h2 className="text-base font-semibold text-[var(--console-text)]">{title}</h2>{children}</section>;
}

function Gallery({ theme, density, onThemeChange, onDensityChange }: { theme: Theme; density: Density; onThemeChange: (theme: Theme) => void; onDensityChange: (density: Density) => void }) {
  const toast = useToast();
  const [field, setField] = useState('样式样本');
  const [choice, setChoice] = useState('surface');
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState('first');
  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const sampleRows = rows.filter((row) => `${row.name}${row.description}`.includes(search));

  return <div className="max-w-6xl mx-auto p-4 sm:p-8 space-y-6">
    <header className="console-card p-4 sm:p-6 flex flex-wrap justify-between gap-4">
      <div className="space-y-2"><BrandLogo inverse={theme === 'dark'} size="lg" /><h1 className="text-xl font-semibold text-[var(--console-text)]">后台 VI 组件展厅</h1><p className="text-sm text-[var(--console-text-secondary)]">全部内容为样式样本；组件和旧 Table 读取同一套主题参数。</p></div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}>主题：{theme === 'dark' ? '深色' : '浅色'}</Button>
        <Button onClick={() => onDensityChange(density === 'compact' ? 'comfortable' : 'compact')}>密度：{density === 'compact' ? '紧凑' : '舒适'}</Button>
        <Button variant="outline" onClick={() => setCommandOpen(true)} leftIcon={<Search className="w-4 h-4" />}>快捷指令样本</Button>
      </div>
    </header>

    <Section title="指标与层级样本">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="数量样式样本" value="128" footnote="中性数字排版" />
        <MetricCard label="比例样式样本" value="98.2" suffix="%" footnote="百分比排版" />
        <MetricCard label="关注样式样本" value="24" status="warning" footnote="关注色与边框" />
        <MetricCard label="异常样式样本" value="3" status="critical" footnote="异常色与边框" />
      </div>
      <div className="flex flex-wrap gap-2">{(['success', 'warning', 'error', 'info', 'neutral', 'brand'] as const).map((variant) => <StatusBadge key={variant} variant={variant} label={`${{ success: '成功', warning: '关注', error: '异常', info: '提示', neutral: '中性', brand: '品牌' }[variant]}样式`} />)}</div>
    </Section>

    <Section title="表单与操作样本">
      <div className="grid md:grid-cols-3 gap-4">
        <Input label="输入框样式样本" value={field} onChange={(event) => setField(event.target.value)} helperText="主要与辅助文字使用主题参数" />
        <Select label="选择器样式样本" value={choice} onChange={setChoice} options={[{ value: 'surface', label: '表面层级' }, { value: 'text', label: '文字层级' }, { value: 'border', label: '边框层级' }]} />
        <Input label="错误提示样式样本" value="样式样本" readOnly error="此行仅展示错误提示样式" />
      </div>
      <div className="flex flex-wrap gap-6"><Checkbox checked={checked} onChange={setChecked} label="复选框样式样本" /><RadioGroup options={[{ value: 'first', label: '单选样式一' }, { value: 'second', label: '单选样式二' }]} value={radio} onChange={setRadio} /></div>
      <div className="flex flex-wrap gap-2">{(['primary', 'secondary', 'outline', 'ghost', 'danger'] as const).map((variant) => <Button key={variant} variant={variant} onClick={() => toast.info('按钮样式样本', '点击反馈展示，不执行任何业务操作')}>{`${{ primary: '主要', secondary: '次要', outline: '线框', ghost: '轻量', danger: '异常' }[variant]}按钮`}</Button>)}<Button disabled>禁用样式</Button><Button isLoading>加载样式</Button></div>
    </Section>

    <Section title="页签与工具栏样本">
      <Tabs items={[{ id: 'overview', label: '概览样式' }, { id: 'details', label: '明细样式', count: 3 }]} activeId={tab} onChange={setTab} />
      <Tabs variant="segmented" items={[{ id: 'overview', label: '概览样式' }, { id: 'details', label: '明细样式' }]} activeId={tab} onChange={setTab} />
      <Toolbar searchValue={search} onSearchChange={setSearch} searchPlaceholder="搜索样式样本名称" density={density} onDensityChange={onDensityChange} onRefresh={() => toast.info('工具栏样式样本', '刷新反馈展示')} actions={<Button size="sm" onClick={() => setDrawerOpen(true)}>抽屉样式</Button>} />
      <DataTable columns={columns} dataSource={sampleRows} rowKey={(row) => row.id} density={density} selectable selectedRowKeys={selectedKeys} onSelectChange={setSelectedKeys} emptyText="没有匹配的样式样本" pagination={{ current: 1, pageSize: 10, total: sampleRows.length, onChange: () => undefined }} />
    </Section>

    <Section title="原有 Table 与普通表格样式对照">
      <div className="swtable overflow-x-auto"><Table caption="原有 Table 样式样本（原 API）" rows={rows} rowKey={(row) => row.id} columns={[{ key: 'name', label: '样本名称', render: (row) => row.name }, { key: 'description', label: '样本说明', render: (row) => row.description }, { key: 'state', label: '样式状态', render: (row) => row.state }]} /></div>
      <div className="swtable overflow-x-auto"><table><caption>普通 table 样式样本</caption><thead><tr><th scope="col">文字层级</th><th scope="col">样本说明</th></tr></thead><tbody><tr><td>主要文字</td><td>表格单元格继承当前主题</td></tr><tr><td>次要文字</td><td>深色与浅色共用组件结构</td></tr></tbody></table></div>
    </Section>

    <Section title="抽屉、弹窗与提示样本">
      <div className="flex flex-wrap gap-2"><Button onClick={() => setDrawerOpen(true)}>打开抽屉样本</Button><Button onClick={() => setModalOpen(true)}>打开弹窗样本</Button><Button onClick={() => toast.success('提示样式样本', '成功状态、正文与关闭按钮')}>成功提示</Button><Button onClick={() => toast.warning('提示样式样本', '关注状态与提示表面')}>关注提示</Button><Button onClick={() => toast.error('提示样式样本', '异常状态与提示表面')}>异常提示</Button></div>
    </Section>

    <Drawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} title="抽屉样式样本" subtitle="标题、表单、正文与底部操作区域" footer={<Button onClick={() => setDrawerOpen(false)}>关闭样本</Button>}><div className="space-y-4"><Input label="抽屉输入样本" value={field} onChange={(event) => setField(event.target.value)} /><p>此内容仅展示组件样式，未连接业务接口。</p><StatusBadge label="样式样本" variant="info" /></div></Drawer>
    <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="弹窗样式样本" subtitle="同一主题参数下的弹窗头部、正文与操作区" confirmText="展示提示" onConfirm={() => toast.info('弹窗样式样本', '已触发组件交互展示')}><p>此内容为样式样本，打开与关闭只改变展厅状态。</p></Modal>
    <CommandPalette isOpen={commandOpen} onClose={() => setCommandOpen(false)} theme={theme} onThemeToggle={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')} onDensityToggle={() => onDensityChange(density === 'compact' ? 'comfortable' : 'compact')} commands={[{ id: 'sample-drawer', title: '打开抽屉样式样本', category: '组件展厅', icon: <Palette className="w-4 h-4" />, action: () => setDrawerOpen(true) }, { id: 'sample-modal', title: '打开弹窗样式样本', category: '组件展厅', action: () => setModalOpen(true) }]} />
  </div>;
}

function ConsoleUIPreview({ initialTheme }: { initialTheme: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [density, setDensity] = useState<Density>('comfortable');
  return <div data-console-theme={theme} data-theme={theme} data-sw-theme={theme} data-density={density} className="min-h-screen bg-[var(--console-canvas)] text-[var(--console-text)] font-[family-name:var(--console-font-sans)]"><ToastProvider><Gallery theme={theme} density={density} onThemeChange={setTheme} onDensityChange={setDensity} /></ToastProvider></div>;
}

export const Light: Story = { render: () => <ConsoleUIPreview initialTheme="light" /> };
export const Dark: Story = { render: () => <ConsoleUIPreview initialTheme="dark" /> };
