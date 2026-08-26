import { ChevronDown, Cloud, Laptop } from 'lucide-react'
import type { WorkflowExecutionConfig } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import { MenuSelect, type MenuOption } from '@/components/common/MenuSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { isCurrentAppDevice } from '@/lib/app-device-registration'
import { cn } from '@/lib/utils'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { ProjectWithTasks } from '@/types/api'
import type { UnifiedModel } from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import {
  workflowExecutionConfigComplete,
  workflowExecutionConfigForAgent,
} from './workflowExecutionConfig'

function deviceHasId(device: DeviceInfo, deviceId: string): boolean {
  return [
    device.device_id,
    device.app_device_id,
    device.socket_device_id,
    ...(device.runtime_routes ?? []).map(route => route.device_id),
  ].some(candidate => candidate?.trim() === deviceId)
}

function ConfigFieldSelect({
  testId,
  value,
  options,
  onChange,
  label,
}: {
  testId: string
  value: string
  options: MenuOption[]
  onChange: (value: string) => void
  label: string
}) {
  return (
    <MenuSelect
      testId={testId}
      value={value}
      options={options}
      onChange={onChange}
      menuWidth={260}
      rootClassName="mt-1.5 block"
      triggerClassName="h-9 w-full rounded-lg border border-border bg-background px-2"
      trigger={
        <span className="flex h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-sm text-text-primary">
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        </span>
      }
    />
  )
}

export function WorkflowExecutionConfigFields({
  value,
  onChange,
  projectAgents,
  runtimeProfiles,
  devices,
  localDeviceIds,
  models,
  localProjects,
  testId,
}: {
  value: WorkflowExecutionConfig
  onChange: (value: WorkflowExecutionConfig) => void
  projectAgents: ProjectChatAgent[]
  runtimeProfiles: RuntimeProfile[]
  devices: DeviceInfo[]
  localDeviceIds: string[]
  models: UnifiedModel[]
  localProjects: ProjectWithTasks[]
  testId: string
}) {
  const { t } = useTranslation('common')
  const selectedWorkspace = value.workspace_binding
    ? value.workspace_binding.type === 'backend_project'
      ? String(value.workspace_binding.projectId)
      : 'standalone'
    : ''
  const complete = workflowExecutionConfigComplete(value)
  const selectedModelKey = value.model ? `${value.model_type ?? ''}:${value.model}` : ''
  const selectedDeviceId = value.execution_device_id?.trim() ?? ''
  const selectedDevice = selectedDeviceId
    ? devices.find(device => deviceHasId(device, selectedDeviceId))
    : undefined
  const deviceOptions: MenuOption[] = [
    {
      value: '',
      label: t('todo.workflow_execution_fill_later', '运行时填写'),
    },
  ]

  if (selectedDeviceId && !selectedDevice) {
    deviceOptions.push({
      value: selectedDeviceId,
      label: t('workbench.environment_device_unknown', '未知设备'),
      icon: <Cloud aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />,
      ariaLabel: t('todo.workflow_execution_cloud_device_named', '云设备 {{name}}', {
        name: t('workbench.environment_device_unknown', '未知设备'),
      }),
    })
  }

  deviceOptions.push(
    ...devices.map(device => {
      const local = isCurrentAppDevice(device, localDeviceIds)
      const label = local
        ? t('todo.workflow_execution_local_device', '本机')
        : device.name?.trim() || t('workbench.environment_device_unknown', '未知设备')
      const optionValue = device === selectedDevice ? selectedDeviceId : device.device_id

      return {
        value: optionValue,
        label,
        icon: local ? (
          <Laptop aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        ) : (
          <Cloud aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        ),
        ariaLabel: local
          ? label
          : t('todo.workflow_execution_cloud_device_named', '云设备 {{name}}', {
              name: label,
            }),
      }
    })
  )

  const selectedDeviceLabel = selectedDevice
    ? isCurrentAppDevice(selectedDevice, localDeviceIds)
      ? t('todo.workflow_execution_local_device', '本机')
      : selectedDevice.name?.trim() || t('workbench.environment_device_unknown', '未知设备')
    : selectedDeviceId
      ? t('workbench.environment_device_unknown', '未知设备')
      : t('todo.workflow_execution_fill_later', '运行时填写')

  return (
    <div
      className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3"
      data-testid={testId}
    >
      <div className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_robot', '机器人预设（可选）')}
        <ConfigFieldSelect
          testId={`${testId}-agent`}
          value={value.agent_id ?? ''}
          options={[
            { value: '', label: t('todo.workflow_execution_no_robot', '不使用机器人预设') },
            ...projectAgents.map(agent => ({ value: agent.id, label: agent.name })),
          ]}
          label={
            projectAgents.find(agent => agent.id === value.agent_id)?.name ??
            t('todo.workflow_execution_no_robot', '不使用机器人预设')
          }
          onChange={next => {
            const agent = projectAgents.find(candidate => candidate.id === next)
            if (!agent) {
              onChange({ ...value, agent_id: null, runtime_profile_id: null })
              return
            }
            const runtimeProfile = runtimeProfiles.find(
              candidate => candidate.id === agent.defaultRuntimeProfileId
            )
            onChange(workflowExecutionConfigForAgent(agent, runtimeProfile))
          }}
        />
      </div>
      <div className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_device', '执行设备')}
        <ConfigFieldSelect
          testId={`${testId}-device`}
          value={value.execution_device_id ?? ''}
          options={deviceOptions}
          label={selectedDeviceLabel}
          onChange={executionDeviceId => {
            onChange({
              ...value,
              execution_device_id: executionDeviceId || null,
              runtime_profile_id:
                runtimeProfiles.find(
                  profile =>
                    profile.id === value.runtime_profile_id &&
                    profile.executionDeviceId === executionDeviceId
                )?.id ?? null,
            })
          }}
        />
      </div>
      <div className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_model', '模型')}
        <ConfigFieldSelect
          testId={`${testId}-model`}
          value={selectedModelKey}
          options={[
            { value: '', label: t('todo.workflow_execution_model_empty', '运行时填写模型') },
            ...(value.model &&
            !models.some(
              model =>
                model.name === value.model && (!value.model_type || model.type === value.model_type)
            )
              ? [{ value: selectedModelKey, label: value.model }]
              : []),
            ...models.map(model => ({
              value: `${model.type}:${model.name}`,
              label: model.displayName || model.name,
            })),
          ]}
          label={
            models.find(model => `${model.type}:${model.name}` === selectedModelKey)?.displayName ??
            models.find(model => `${model.type}:${model.name}` === selectedModelKey)?.name ??
            value.model ??
            t('todo.workflow_execution_model_empty', '运行时填写模型')
          }
          onChange={next => {
            const selectedModel = models.find(model => `${model.type}:${model.name}` === next)
            if (!selectedModel) {
              onChange({
                ...value,
                model: null,
                model_type: null,
                model_options: {},
              })
              return
            }
            const execution = selectedModelExecutionFields(selectedModel, {})
            onChange({
              ...value,
              model: execution.modelId ?? null,
              model_type: execution.modelType ?? null,
              model_options: execution.modelOptions ?? {},
            })
          }}
        />
      </div>
      <div className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_project', '代码项目')}
        <ConfigFieldSelect
          testId={`${testId}-project`}
          value={selectedWorkspace}
          options={[
            {
              value: '',
              label: t('todo.workflow_execution_project_empty', '请选择代码项目'),
            },
            {
              value: 'standalone',
              label: t('todo.workflow_execution_standalone', '独立对话目录（不绑定项目）'),
            },
            ...localProjects.map(project => ({
              value: String(project.id),
              label: project.name,
            })),
          ]}
          label={
            selectedWorkspace === 'standalone'
              ? t('todo.workflow_execution_standalone', '独立对话目录（不绑定项目）')
              : (localProjects.find(project => String(project.id) === selectedWorkspace)?.name ??
                t('todo.workflow_execution_project_empty', '请选择代码项目'))
          }
          onChange={next =>
            onChange({
              ...value,
              workspace_binding:
                next === 'standalone'
                  ? { type: 'standalone' }
                  : next
                    ? { type: 'backend_project', projectId: Number(next) }
                    : null,
            })
          }
        />
      </div>
      <p className={cn('text-xs', complete ? 'text-emerald-600' : 'text-amber-600')}>
        {complete
          ? t('todo.workflow_execution_complete', '运行配置已完整')
          : t('todo.workflow_execution_incomplete', '未填项将在 Issue 进入进行中时补充')}
      </p>
    </div>
  )
}
