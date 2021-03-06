import {HttpWorkerConfig, BrowserWorkerConfig} from './config';
import {RequestError, HTTPError} from 'got';
import {Logger, getLogger} from '@lib/misc/logger';
import {MetadataHandler} from './metadata';
import {WorkerStatus} from './worker';
import {CrawlConfig} from './config';
import {PageError} from './browser_worker';
import {VersionInfo} from '@lib/types/common';
import {S3Controller} from '@lib/storage/storage';
import { BrowserWorker } from './browser_worker';
import { startProxyServer } from './proxy_server';
import {puppeteer_proxy_error_needles, http_codes_proxy_failure} from './handler';
import {ResultPolicy, ExecutionEnv} from '@lib/types/common';
import {LogLevel} from "@lib/misc/logger";
import _ from 'underscore';
const got = require('got');
const md5 = require('md5');

export enum State {
  initial = 'initial',
  running = 'running',
  failed = 'failed'
}

export class PersistantCrawlHandler {
  config: BrowserWorkerConfig;
  logger: Logger;
  state: State;
  browser_worker: BrowserWorker | null;
  proxy_server: any;
  counter: number;
  crawler_cache: any;

  constructor() {
    this.logger = getLogger(null, 'persistantHandler', LogLevel.verbose);
    this.state = State.initial;
    this.browser_worker = null;
    let config_handler = new CrawlConfig({} as BrowserWorkerConfig);
    this.config = (config_handler.getDefaultConfig()) as BrowserWorkerConfig;
    this.proxy_server = null;
    this.counter = 0;
    this.crawler_cache = {};
  }

  public async setup() {
    if (this.state === State.initial) {
      this.browser_worker = new BrowserWorker(this.config as BrowserWorkerConfig);
      await this.browser_worker.setup();
      this.state = State.running;
    }
  }

  public async restartBrowser() {
    if (this.browser_worker) {
      this.logger.info(`Attempting to restart browser worker.`);
      let t0 = new Date();
      await this.browser_worker.cleanup();
      this.browser_worker = new BrowserWorker(this.config as BrowserWorkerConfig);
      await this.browser_worker.setup();
      let t1 = new Date();
      this.logger.info(`Restarted browser worker in ${(t1.valueOf() - t0.valueOf())}ms.`);
    }
  }

  private updateConfig(body: any) {
    // set default config options
    this.config.worker_id = 1;
    this.config.result_policy = ResultPolicy.return;
    this.config.apply_evasion = true;
    this.config.block_webrtc = true;
    this.config.block_webrtc_extension = false;
    this.config.default_navigation_timeout = 30000;
    this.config.request_timeout = 15000;
    this.config.pup_args = [`--proxy-server=http://localhost:8000`];

    let update_keys: Array<string> = ['function_code', 'items',
     'loglevel', 'options', 'worker_metadata', 'cookies',
      'default_accept_language', 'random_accept_language',
       'headers', 'user_agent', 'default_navigation_timeout',
        'intercept_types', 'recaptcha_provider', 'timezone', 'language',
         'test_evasion', 'test_webrtc_leak', 'random_user_agent', 'user_agent_options',
       'apply_evasion', 'block_webrtc', 'incognito_page', 'clear_cookies'];

    for (let key of update_keys) {
      if (body[key] !== undefined) {
        this.logger.info(`${key}=${body[key]}`);
        // @ts-ignore
        this.config[key] = body[key];
      }
    }
  }

  private async restartProxyServer(proxy: string | null) {
    // if an old proxy server is running, forcefully shut it down
    // and start a new one.
    // reason: all pending keep-alive connections should not be re-used
    // with a potentially different proxy server
    let t0 = new Date();
    if (this.proxy_server) {
      await this.proxy_server.close(true);
    }
    this.proxy_server = await startProxyServer(proxy);
    let t1 = new Date();
    this.logger.info(`Restarted proxy server in ${(t1.valueOf() - t0.valueOf())}ms.`);
  }

  private async closeProxyConnections() {
    let t0 = new Date();
    let count = 0;
    _.each(this.proxy_server.handlers, (handler: any) => {
        count++;
        handler.close();
    });
    let t1 = new Date();
    this.logger.info(`Closed ${count} proxy handlers in ${(t1.valueOf() - t0.valueOf())}ms.`);
  }

  // Get crawler code from github
  // cache the code for speed
  private async getCrawlerCode(body: any) {
    let crawler_name = body.crawler;
    let no_cache: boolean = (body.no_cache === true);

    let crawlers = {
      render: 'new_render.js',
      google: 'new_google_scraper.js',
      bing: 'new_bing_scraper.js',
      raw: 'new_render_raw.js',
      fp: 'new_fp.js',
      webrtc: 'new_webrtc_check.js',
    }

    if (!Object.keys(crawlers).includes(crawler_name)) {
      return false;
    }

    if (this.crawler_cache[crawler_name] && no_cache === false) {
      this.logger.info(`Using cache for crawler ${crawler_name}`);
      return this.crawler_cache[crawler_name];
    }

    try {
      // @ts-ignore
      let base_url = `https://raw.githubusercontent.com/NikolaiT/scrapeulous/master/${crawlers[crawler_name]}`;
      let response = await got(base_url, {
        method: 'GET',
        timeout: 10000,
      });
      let code = response.body;
      this.logger.info(`Downloaded ${code.length} bytes of code from ${base_url}`);
      this.crawler_cache[crawler_name] = code;
      return code;
    } catch (err) {
      this.logger.error(`Failed obtaining crawler code: ${err}`);
      return false;
    }
  }

  private getId(body: any, created_at: string) {
    let str_data = JSON.stringify(body.items) + body.crawler + created_at;
    return md5(str_data);
  }

  // store html and json results
  // on s3
  // @todo: currently we only store the first page
  // @todo: fix that
  private async storeResults(id: string, results: any) {
    try {
      let controller = new S3Controller(this.config.aws_config);
      let bytes_uploaded = 0;
      let html = results[0].html.repeat(1);
      delete results[0].html;
      // first upload the html
      let html_fname = id + '.html';
      bytes_uploaded = await controller.upload(html_fname, html, false, 'text/html; charset=utf-8');
      this.logger.info(`Uploaded ${bytes_uploaded} bytes to ${html_fname}`);
      // then upload the json
      let json_fname = id + '.json';
      bytes_uploaded = await controller.upload(json_fname, JSON.stringify(results[0], null, 2), false);
      this.logger.info(`Uploaded ${bytes_uploaded} bytes to ${json_fname}`);
    } catch (error) {
      this.logger.error(`Could not upload results to s3: ${error}`);
    }
  }

  /**
   * Each run() function call can update some config properties that
   * are not required during startup of the browser.
   */
  public async run(body: any) {
    let search_metadata: any = {
      id: '',
      status: "Success",
      json_endpoint: '',
      created_at: new Date(),
      processed_at: '',
      raw_html_file: '',
      total_time_taken: 0,
      time_taken_crawling: 0,
    };
    search_metadata.id = this.getId(body, search_metadata.created_at);
    search_metadata.json_endpoint = `https://crawling-searches.s3-us-west-1.amazonaws.com/${search_metadata.id}.json`;
    search_metadata.raw_html_file = `https://crawling-searches.s3-us-west-1.amazonaws.com/${search_metadata.id}.html`;
    this.logger.info('---------------------');
    this.logger.info(`[n=${this.counter}] Api Call: ${JSON.stringify(body, null, 1)}`);
    await this.updateConfig(body);
    await this.setup();
    const results: any = [];

    if (this.browser_worker === null) {
      return results;
    }

    // assign the possibly updated config
    this.browser_worker.config = this.config;
    this.logger.verbose('Using config: ' + JSON.stringify(this.config, null, 1));

    let items = body.items || [];
    // reload the browser page and close the current one
    // only reload the browser page after at least one invocatoin occured
    if (this.browser_worker && this.counter > 0) {
      await this.browser_worker.setupPage(body.user_agent || '');
    }

    if (body.proxy) {
      this.logger.info('Using proxy: ' + body.proxy);
    }
    // always restart the proxy server. Also if we don't use a proxy
    // reason: otherwise the old proxy is still used. We don't want that.
    // Some api calls might be without proxy
    await this.restartProxyServer(body.proxy || null);

    try {
      let worker = null;
      let WorkerClass = null;
      let function_code = await this.getCrawlerCode(body);
      if (function_code === false) {
        return {
          error: 'invalid crawler propery. Allowed: crawler: google | bing | render',
        }
      }

      WorkerClass = eval('(' + function_code + ')');
      worker = new WorkerClass();
      this.logger.info(`[n=${this.counter}] Using crawler: ${worker.constructor.name}`);
      // copy functionality from parent class
      // @TODO: find better way
      worker.page = this.browser_worker.page;
      worker.options = this.browser_worker.options;
      worker.logger = this.browser_worker.logger;
      worker.sleep = this.browser_worker.sleep;
      worker.random_sleep = this.browser_worker.random_sleep;
      worker.clean_html = this.browser_worker.clean_html;

      for (let i = 0; i < items.length; i++) {
        let item = items[i];
        // check if we need to abort crawling
        if (this.browser_worker.status !== WorkerStatus.healthy) {
          this.logger.warn(`Abort crawling for reason: ${this.browser_worker.status}`);
          break;
        }

        let elapsed: number = 0;
        let t0 = new Date();
        try {
          search_metadata.processed_at = new Date();
          let result = await worker.crawl(item);
          results.push(result);
          let t1 = new Date();
          elapsed = t1.valueOf() - t0.valueOf();
          search_metadata.time_taken_crawling += elapsed;
          this.logger.verbose(`[${i}] Successfully crawled item ${item} in ${elapsed}ms`);
          if (this.config.intercept_types) {
            this.logger.verbose(JSON.stringify(this.browser_worker.request_info, null, 1));
          }
          // dont wait for the upload to finish
          if (body.crawler.toLowerCase() === 'google' || body.crawler.toLowerCase() === 'bing') {
            this.storeResults(search_metadata.id, result).then((uploaded) => {
              this.logger.info(`[${i}] Done uploading results to s3...`);
            });
          }
        } catch (Error) {
          if (elapsed === 0) {
            elapsed = (new Date()).valueOf() - t0.valueOf();
            search_metadata.time_taken_crawling += elapsed;
          }
          search_metadata.status = 'Failed';
          this.logger.error(`[${i}] Failed to crawl item ${item} with error: ${Error.message}`);
          let err_message = Error.toString();
          let block_detected: boolean = false;
          for (let needle of puppeteer_proxy_error_needles) {
            if (err_message.includes(needle)) {
              this.logger.info(`Request blocked/detected in browser worker: ${needle}`);
              block_detected = true;
            }
          }
          results.push({
            'error_message': Error.toString(),
            'error_trace': Error.stack,
          });
        }
      }
      this.counter++;
    } catch (error) {
      search_metadata.status = 'Internal Error: ' + Error.toString();
      this.logger.error(error.stack);
    } finally {
      search_metadata.total_time_taken = ((new Date()).valueOf() - search_metadata.created_at) / 1000;
      search_metadata.time_taken_crawling /= 1000;
    }

    if (search_metadata.status.startsWith('Internal Error') || body.restart_browser === true) {
      await this.restartBrowser();
    }

    return {
      search_metadata: search_metadata,
      results: results,
    }
  }
}
