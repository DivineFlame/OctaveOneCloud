import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { ConnectorCallbackController, ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';

@Module({ imports: [AuthModule, OrgsModule], controllers: [ConnectorsController, ConnectorCallbackController], providers: [ConnectorsService], exports: [ConnectorsService] })
export class ConnectorsModule {}
