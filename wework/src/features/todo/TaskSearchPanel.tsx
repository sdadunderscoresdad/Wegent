import { ChevronDown, Search, X } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { MenuSelect, type MenuOption } from '@/components/common/MenuSelect'
import { cn } from '@/lib/utils'
import { columns, priorityBadgeClasses } from './todoShared'
import {
  emptyTaskSearchFilters,
  hasTaskSearchFilters,
  searchTasks,
  type TaskSearchFilters,
} from './taskSearch'

interface TaskSearchPanelProps {
  items: CloudLoopItem[]
  members: CloudProjectMember[]
  query: string
  filters: TaskSearchFilters
  tags: string[]
  onQueryChange: (query: string) => void
  onFiltersChange: (filters: TaskSearchFilters) => void
  onSelect: (item: CloudLoopItem) => void
}

function SearchFilterSelect({
  testId,
  label,
  value,
  options,
  onChange,
}: {
  testId: string
  label: string
  value: string
  options: MenuOption[]
  onChange: (value: string) => void
}) {
  return (
    <MenuSelect
      testId={testId}
      ariaLabel={label}
      value={value}
      options={options}
      onChange={onChange}
      menuWidth={200}
      triggerClassName="h-8 rounded-lg border border-border bg-background px-2"
      trigger={
        <span className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-text-secondary">
          <span className="max-w-40 truncate">
            {options.find(option => option.value === value)?.label ?? value}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        </span>
      }
    />
  )
}

export function TaskSearchPanel({
  items,
  members,
  query,
  filters,
  tags,
  onQueryChange,
  onFiltersChange,
  onSelect,
}: TaskSearchPanelProps) {
  const results = searchTasks(items, query, filters, members)
  const active = Boolean(query.trim()) || hasTaskSearchFilters(filters)

  return (
    <div
      data-testid="cloud-project-task-search-panel"
      className="electron-titlebar-interactive-region absolute right-6 top-12 z-30 w-[560px] max-w-[calc(100vw-48px)] rounded-xl border border-border bg-background p-3 shadow-xl"
    >
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
        <input
          autoFocus
          data-testid="cloud-project-task-search-input"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="搜索任务编号、标题、内容、标签或成员"
          className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-sm outline-none focus:border-text-muted"
        />
        {active && (
          <button
            type="button"
            data-testid="cloud-project-task-search-clear"
            onClick={() => {
              onQueryChange('')
              onFiltersChange(emptyTaskSearchFilters)
            }}
            className="absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-muted"
            aria-label="清除搜索"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <SearchFilterSelect
          testId="cloud-task-filter-status"
          label="按状态筛选"
          value={filters.status ?? ''}
          options={[
            { value: '', label: '全部状态' },
            ...columns.map(column => ({ value: column.status, label: column.label })),
          ]}
          onChange={next =>
            onFiltersChange({
              ...filters,
              status: (next || null) as CloudLoopItem['status'] | null,
            })
          }
        />
        <SearchFilterSelect
          testId="cloud-task-filter-priority"
          label="按优先级筛选"
          value={filters.priority ?? ''}
          options={[
            { value: '', label: '全部优先级' },
            { value: 'none', label: '普通' },
            { value: 'low', label: '低' },
            { value: 'medium', label: '中' },
            { value: 'high', label: '高' },
            { value: 'urgent', label: '紧急' },
          ]}
          onChange={next =>
            onFiltersChange({
              ...filters,
              priority: (next || null) as CloudLoopItem['priority'] | null,
            })
          }
        />
        <SearchFilterSelect
          testId="cloud-task-filter-tag"
          label="按标签筛选"
          value={filters.tag ?? ''}
          options={[
            { value: '', label: '全部标签' },
            ...tags.map(tag => ({ value: tag, label: tag })),
          ]}
          onChange={next => onFiltersChange({ ...filters, tag: next || null })}
        />
        <SearchFilterSelect
          testId="cloud-task-filter-assignee"
          label="按负责人筛选"
          value={filters.assigneeUserId ? String(filters.assigneeUserId) : ''}
          options={[
            { value: '', label: '全部负责人' },
            ...members.map(member => ({
              value: String(member.user_id),
              label: member.user_name,
            })),
          ]}
          onChange={next =>
            onFiltersChange({
              ...filters,
              assigneeUserId: next ? Number(next) : null,
            })
          }
        />
        <SearchFilterSelect
          testId="cloud-task-filter-creator"
          label="按创建人筛选"
          value={filters.creatorUserId ? String(filters.creatorUserId) : ''}
          options={[
            { value: '', label: '全部创建人' },
            ...members.map(member => ({
              value: String(member.user_id),
              label: member.user_name,
            })),
          ]}
          onChange={next =>
            onFiltersChange({
              ...filters,
              creatorUserId: next ? Number(next) : null,
            })
          }
        />
        <SearchFilterSelect
          testId="cloud-task-filter-due"
          label="按截止时间筛选"
          value={filters.due}
          options={[
            { value: 'any', label: '全部截止时间' },
            { value: 'with_due_date', label: '有截止时间' },
            { value: 'overdue', label: '已逾期' },
            { value: 'no_due_date', label: '无截止时间' },
          ]}
          onChange={next => onFiltersChange({ ...filters, due: next as TaskSearchFilters['due'] })}
        />
        <SearchFilterSelect
          testId="cloud-task-filter-children"
          label="按子任务筛选"
          value={filters.children}
          options={[
            { value: 'any', label: '全部任务层级' },
            { value: 'with_children', label: '有子任务' },
            { value: 'without_children', label: '无子任务' },
          ]}
          onChange={next =>
            onFiltersChange({
              ...filters,
              children: next as TaskSearchFilters['children'],
            })
          }
        />
      </div>
      <div className="mt-3 max-h-[420px] overflow-y-auto">
        {!active ? (
          <p className="px-3 py-8 text-center text-sm text-text-muted">输入关键词或选择筛选条件</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-text-muted">没有匹配的任务</p>
        ) : (
          <>
            <p className="px-2 pb-1 text-xs text-text-muted">{results.length} 个结果</p>
            {results.map(({ item, parentPath }) => (
              <button
                key={item.id}
                type="button"
                data-testid={`cloud-task-search-result-${item.id}`}
                disabled={item.can_view_detail === false}
                onClick={() => onSelect(item)}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/60 disabled:cursor-default disabled:opacity-60"
              >
                <span className="mt-0.5 shrink-0 font-mono text-xs text-text-muted">{item.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-text-muted">
                    {item.can_view_detail === false
                      ? '仅创建人可查看详情'
                      : parentPath.length > 0
                        ? parentPath.join(' / ')
                        : '顶层任务'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-muted">
                  {columns.find(column => column.status === item.status)?.label}
                </span>
                {item.priority !== 'none' && (
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-1.5 py-0.5 text-xs',
                      priorityBadgeClasses[item.priority]
                    )}
                  >
                    {item.priority}
                  </span>
                )}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
