import * as core from '@actions/core'

async function run(): Promise<void> {
  try {
    const rawVariables: string[] = core.getMultilineInput('tfVars')
    core.info('Variables:')
    core.info(rawVariables.toString()) // debug is only output if you set the secret `ACTIONS_STEP_DEBUG` to true

    core.setOutput('time', new Date().toTimeString())
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
