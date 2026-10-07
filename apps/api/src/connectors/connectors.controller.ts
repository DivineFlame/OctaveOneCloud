import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AppConfig, CredentialCipher } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { CIPHER } from '../common/common.module';
import { FlowCookie } from '../common/flow-cookie';
import { AuthContext, AuthedRequest, CurrentAuth } from '../auth/decorators';
import { OrgGuard, RequireOrgPermission } from '../orgs/org.guard';
import { ConnectorFlow, ConnectorsService } from './connectors.service';

const flowCookie = (cipher: CredentialCipher, secure: boolean) => new FlowCookie<ConnectorFlow>('ooc_connector', 'connector-flow', cipher, secure);

@UseGuards(OrgGuard)
@Controller('orgs/:orgId/connectors')
export class ConnectorsController {
  private readonly cookie: FlowCookie<ConnectorFlow>;
  constructor(private readonly connectors: ConnectorsService, @Inject(APP_CONFIG) config: AppConfig, @Inject(CIPHER) cipher: CredentialCipher) {
    this.cookie = flowCookie(cipher, config.COOKIE_SECURE);
  }

  @RequireOrgPermission('services.read')
  @Get()
  list(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.connectors.list(orgId);
  }

  /** Returns the provider URL; the browser navigates there (a flow cookie binds the callback to this user and org). */
  @RequireOrgPermission('services.manage')
  @HttpCode(200)
  @Post(':provider/start')
  start(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('provider') provider: string, @CurrentAuth() a: AuthContext, @Res({ passthrough: true }) res: Response) {
    const { authorizeUrl, flow } = this.connectors.start(orgId, provider, a.user.id);
    this.cookie.set(res, flow);
    return { authorizeUrl };
  }

  @RequireOrgPermission('services.manage')
  @HttpCode(200)
  @Post('grants/:grantId/revoke')
  revoke(@Param('orgId', ParseUUIDPipe) orgId: string, @Param('grantId', ParseUUIDPipe) grantId: string, @CurrentAuth() a: AuthContext) {
    return this.connectors.revoke(orgId, grantId, a.user.id);
  }
}

/** Provider redirect target (signed-in user required; state and PKCE verifier come from the flow cookie). */
@Controller('connectors')
export class ConnectorCallbackController {
  private readonly cookie: FlowCookie<ConnectorFlow>;
  constructor(private readonly connectors: ConnectorsService, @Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(CIPHER) cipher: CredentialCipher) {
    this.cookie = flowCookie(cipher, config.COOKIE_SECURE);
  }

  @Get('callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') providerError: string | undefined, @Req() req: AuthedRequest, @CurrentAuth() a: AuthContext, @Res() res: Response) {
    const flow = this.cookie.take(req, res);
    const back = (orgId: string | undefined, q: string) => res.redirect(302, `${this.config.APP_URL}${orgId ? `/dashboard/orgs/${orgId}/connectors` : '/dashboard'}?${q}`);
    if (!flow || !state || state !== flow.state) return back(flow?.orgId, 'connector_error=expired');
    if (providerError || !code) return back(flow.orgId, `connector_error=${encodeURIComponent(providerError ?? 'denied')}`);
    try {
      await this.connectors.finish(flow, code, a.user.id);
      return back(flow.orgId, `connected=${encodeURIComponent(flow.provider)}`);
    } catch (e) {
      return back(flow.orgId, `connector_error=${encodeURIComponent((e as { response?: { error?: string } }).response?.error ?? 'failed')}`);
    }
  }
}
