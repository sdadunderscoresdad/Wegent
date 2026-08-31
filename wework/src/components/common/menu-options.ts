import type { MenuOption } from './MenuSelect'

export function timeMenuOptions(value: string): MenuOption[] {
  const options = Array.from({ length: 96 }, (_, index) => {
    const hour = Math.floor(index / 4)
    const minute = (index % 4) * 15
    const raw = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    return { value: raw, label: `${hour}:${String(minute).padStart(2, '0')}` }
  })
  if (!options.some(option => option.value === value)) {
    const [hour = '0', minute = '00'] = value.split(':')
    options.push({ value, label: `${Number(hour)}:${minute}` })
    options.sort((left, right) => left.value.localeCompare(right.value))
  }
  return options
}
