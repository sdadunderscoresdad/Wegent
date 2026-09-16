import { installMainProcessLogCapture } from './main-process-log.js'
import { installProcessOutputErrorHandlers } from './process-output.js'

installProcessOutputErrorHandlers()
installMainProcessLogCapture()
