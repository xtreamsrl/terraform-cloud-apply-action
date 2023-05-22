import * as core from '@actions/core'
import Terraform from './terraform'

async function run(): Promise<void> {
  try {
    const token = core.getInput('tfToken')
    const org = core.getInput('tfOrg')
    const workspace = core.getInput('tfWorkspace')
    const filePath = core.getInput('filePath')
    const identifier = core.getInput('identifier')
    const rawVariables: string[] = core.getMultilineInput('tfVars')

    const processedVars = rawVariables.map(item => {
      const [key, value] = item.split('=')
      return {key, value}
    })
    core.info('Variables:')
    core.info(processedVars.toString())

    const tf = new Terraform(
      token,
      org,
      `app.terraform.io`,
      true,
      10,
      30 * 1000
    )

    const {runId, status} = await tf.run(
      workspace,
      filePath,
      identifier,
      processedVars
    )
    core.setOutput('runId', runId)
    core.setOutput('status', status)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
