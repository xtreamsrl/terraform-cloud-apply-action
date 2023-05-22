import fs from 'fs'
// eslint-disable-next-line import/named
import axios, {AxiosInstance} from 'axios'
import * as core from '@actions/core'

export default class Terraform {
  private axios: AxiosInstance
  private org: string
  private awaitApply: boolean
  private retryLimit: number
  private uploadRetryInterval: number
  private pollInterval: number
  private tfcInterval: number
  private debug: boolean
  /**
   * Terraform Cloud class.
   *
   * @param {string}  token - Terraform Cloud token.
   * @param {string}  org - Terraform Cloud organization.
   * @param {string}  [address=`app.terraform.com`] - Terraform Cloud address.
   * @param {boolean} [awaitApply=false] - Wait until plan status is complete or applied before returning.
   * @param {number}  [retryLimit=5] - Maximum number of retries for API calls.
   * @param {number}  [pollInterval=60000] - Duration (ms) to wait before retrying plan status request.
   * @param {number}  [uploadRetryInterval=1000] - Duration (ms) to wait before retrying configuration version request.
   * @param {boolean} [debug=false] - Toggle additional log messages.
   */
  constructor(
    token: string,
    org: string,
    address = `app.terraform.io`,
    awaitApply = false,
    retryLimit = 5,
    pollInterval = 60000,
    uploadRetryInterval = 1000,
    debug = false
  ) {
    this.axios = axios.create({
      baseURL: `https://${address}/api/v2`,
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': `application/vnd.api+json`
      },
      maxContentLength: Infinity,
      timeout: 5000
    })
    this.org = org
    this.awaitApply = awaitApply
    this.retryLimit = retryLimit
    this.pollInterval = pollInterval
    this.uploadRetryInterval = uploadRetryInterval
    this.debug = debug
    this.tfcInterval = 1000
  }

  /**
   * Wait for specified time.
   *
   * @param {number} ms - Duration.
   * @returns {promise} - Promise.
   */
  async _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Check workspace exists, and returns Id.
   */
  async _checkWorkspace(workspace: string): Promise<string> {
    try {
      if (workspace.includes(' ')) {
        throw new Error(`Workspace name should not contain spaces.`)
      }
      const res = await this.axios.get(
        `/organizations/${this.org}/workspaces/${workspace}`
      )
      if (!res.data || !res.data.data) {
        throw new Error('No data returned from request.')
      } else if (!res.data.data.id) {
        throw new Error('Workspace not found.')
      }

      return res.data.data.id
    } catch (err) {
      throw new Error(
        `Error checking the workspace: ${
          (err as Error).message
        }\n${JSON.stringify(err)}`
      )
    }
  }

  /**
   * Get configuration version upload status.
   *
   * @param {string} configVersionId - The ID of the configuration version.
   * @returns {string} - Upload status.
   */
  async _getConfigVersionStatus(configVersionId: string): Promise<string> {
    try {
      const res = await this.axios.get(
        `/configuration-versions/${configVersionId}`
      )

      return res.data.data.attributes.status
    } catch (err) {
      throw new Error(
        `Error getting configuration version: ${
          (err as Error).message
        }\n${JSON.stringify(err)}`
      )
    }
  }

  /**
   * Create new configuration version, and returns upload URL.
   *
   * @param {string} workspaceId - Worspace Id.
   * @returns {object} - Configuration object with id and uploadUrl attributes.
   */
  async _createConfigVersion(
    workspaceId: string
  ): Promise<{id: string; uploadUrl: string}> {
    try {
      const body = {
        data: {
          type: 'configuration-versions',
          attributes: {
            'auto-queue-runs': false
          }
        }
      }
      const res = await this.axios.post(
        `/workspaces/${workspaceId}/configuration-versions`,
        JSON.stringify(body)
      )
      const configVersion = res.data ? res.data.data : null
      if (configVersion === null) {
        throw new Error('No configuration returned from request.')
      }
      return {
        id: configVersion.id,
        uploadUrl: configVersion.attributes['upload-url']
      }
    } catch (err) {
      throw new Error(
        `Error creating the config version: ${
          (err as Error).message
        }\n${JSON.stringify(err)}`
      )
    }
  }

  /**
   * Uploads assets to new configuration version.
   *
   * @param {string} configId - The configuration Id.
   * @param {string} uploadUrl - Url for configuration upload.
   * @param {string} filePath - The tar.gz file for upload.
   */
  async _uploadConfiguration(
    configId: string,
    uploadUrl: string,
    filePath: string
  ): Promise<void> {
    try {
      await this.axios.put(uploadUrl, fs.createReadStream(filePath), {
        headers: {'Content-Type': `application/octet-stream`}
      })
      // Wait for TFC to update to avoid ECONNRESET - this could be neater.
      core.info(`Sleeping for TFC ${this.tfcInterval} ms.`)
      await this._sleep(this.tfcInterval)
      let status = await this._getConfigVersionStatus(configId)
      let counter = 0

      while (status === 'pending') {
        if (counter < this.retryLimit) {
          await this._sleep(this.uploadRetryInterval)
          status = await this._getConfigVersionStatus(configId)
          counter += 1
        } else {
          throw new Error(
            `Config version status was still pending after ${this.retryLimit} attempts.`
          )
        }
      }

      if (status !== 'uploaded') {
        throw new Error(
          `Invalid config version status: ${JSON.stringify(status)}`
        )
      }
    } catch (err) {
      throw new Error(
        `Error uploading the configuration: ${
          (err as Error).message
        }\n${JSON.stringify(err)}.`
      )
    }
  }

  /**
   * Requests run of new configuration.
   *
   * @param {string} workspaceId - Workspace Id.
   * @param {string} identifier - Unique identifier for the run (e.g. git commit).
   * @param variables
   * @returns {string} - Run Id.
   */
  async _run(
    workspaceId: string,
    identifier: string,
    variables: object[]
  ): Promise<{runId: string; status: string | undefined}> {
    try {
      const run = {
        data: {
          attributes: {
            'is-destroy': false,
            message: `Queued by TFC GH Action (${identifier})`,
            variables
          },
          type: 'runs',
          relationships: {
            workspace: {
              data: {
                type: 'workspaces',
                id: workspaceId
              }
            }
          }
        }
      }
      const data = JSON.stringify(run)
      core.info('\nData: ')
      core.info(data)
      const res = await this.axios.post('/runs', data)
      if (!res.data || !res.data.data) {
        throw new Error('No data returned from request.')
      } else if (!res.data.data.id) {
        throw new Error('Run Id not found.')
      }
      const runId = res.data.data.id
      const status = res.data.data.attributes.status

      return {runId, status}
    } catch (err) {
      let message = `Error requesting the run: ${
        (err as Error).message
      }\n${JSON.stringify(err)}`
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      if (err?.response) {
        message += `\nResponse: ${JSON.stringify(
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          err?.response.data ? err?.response.data.errors : null
        )}`
      }
      throw new Error(message)
    }
  }

  /**
   * Requests status of run.
   *
   * @param {string} runId - Run Id.
   * @returns {string} - Status.
   */
  async _getStatus(runId: string): Promise<string> {
    const res = await this.axios.get(`/runs/${runId}`)

    return res.data.data.attributes.status
  }

  /**
   * Repeatedly polls status of run.
   *
   * @param {string} runId - Run Id.
   * @returns {string} - Status.
   */
  async _poll(runId: string): Promise<string | undefined> {
    try {
      for (let i = 0; i < this.retryLimit; i++) {
        const status = await this._getStatus(runId)
        if (status === 'planned_and_finished' || status === 'applied') {
          core.info(`Status is ${JSON.stringify(status)}. Proceed.`)
          return status
        }
        if (status === 'discarded') {
          throw new Error(`Run was discarded.`)
        }
        if (status === 'errored') {
          throw new Error(`Run failed!.`)
        }
        if (i === this.retryLimit - 1) {
          throw new Error(
            `Timed out. Last run status was ${JSON.stringify(status)}`
          )
        }
        core.info(
          `Plan not finished/applied. Will now sleep for ${this.pollInterval}`
        )
        await this._sleep(this.pollInterval)
      }
    } catch (err) {
      core.error(`Error requesting run status. ${(err as Error).message}`)
      throw new Error(
        `Error requesting run status. ${
          (err as Error).message
        }\n${JSON.stringify(err)}`
      )
    }
  }

  /**
   * Create, initialize and start a new workspace run.
   *
   * @param {string} workspace - Workspace name.
   * @param {string} filePath - Path to tar.gz file with Terraform configuration.
   * @param {string} identifier - Unique identifier for the run (e.g. git commit).
   * @param variables
   * @returns {string} - The Id of the new run.
   */
  async run(
    workspace: string,
    filePath: string,
    identifier: string,
    variables: object[]
  ): Promise<{runId: string; status: string | undefined}> {
    const workspaceId = await this._checkWorkspace(workspace)
    const {id, uploadUrl} = await this._createConfigVersion(workspaceId)
    await this._uploadConfiguration(id, uploadUrl, filePath)
    // eslint-disable-next-line prefer-const
    let {runId, status} = await this._run(workspaceId, identifier, variables)
    if (this.awaitApply) {
      status = await this._poll(runId)
    }

    return {runId, status}
  }
}
