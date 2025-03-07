import { Inject, Injectable } from '@nestjs/common';

import { FetchMessagesByBatchesService } from 'src/workspace/messaging/services/fetch-messages-by-batches.service';
import { GmailClientProvider } from 'src/workspace/messaging/providers/gmail/gmail-client.provider';
import { MessagingUtilsService } from 'src/workspace/messaging/services/messaging-utils.service';
import { MessageQueue } from 'src/integrations/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/integrations/message-queue/services/message-queue.service';
import {
  GmailFullSyncJobData,
  GmailFullSyncJob,
} from 'src/workspace/messaging/jobs/gmail-full-sync.job';

@Injectable()
export class GmailFullSyncService {
  constructor(
    private readonly gmailClientProvider: GmailClientProvider,
    private readonly fetchMessagesByBatchesService: FetchMessagesByBatchesService,
    private readonly utils: MessagingUtilsService,
    @Inject(MessageQueue.messagingQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  public async fetchConnectedAccountThreads(
    workspaceId: string,
    connectedAccountId: string,
    nextPageToken?: string,
  ): Promise<void> {
    const { workspaceDataSource, dataSourceMetadata } =
      await this.utils.getDataSourceMetadataWorkspaceMetadata(workspaceId);

    const connectedAccount = await this.utils.getConnectedAcountByIdOrFail(
      connectedAccountId,
      dataSourceMetadata,
      workspaceDataSource,
    );

    const accessToken = connectedAccount.accessToken;
    const refreshToken = connectedAccount.refreshToken;

    if (!refreshToken) {
      throw new Error('No refresh token found');
    }

    const gmailMessageChannel = await workspaceDataSource?.query(
      `SELECT * FROM ${dataSourceMetadata.schema}."messageChannel" WHERE "connectedAccountId" = $1 AND "type" = 'email' LIMIT 1`,
      [connectedAccountId],
    );

    if (!gmailMessageChannel.length) {
      throw new Error(
        `No gmail message channel found for connected account ${connectedAccountId}`,
      );
    }

    const gmailMessageChannelId = gmailMessageChannel[0].id;

    const gmailClient =
      await this.gmailClientProvider.getGmailClient(refreshToken);

    const messages = await gmailClient.users.messages.list({
      userId: 'me',
      maxResults: 500,
      pageToken: nextPageToken,
    });

    const messagesData = messages.data.messages;

    const messageExternalIds = messagesData
      ? messagesData.map((message) => message.id || '')
      : [];

    if (!messageExternalIds || messageExternalIds?.length === 0) {
      return;
    }

    const existingMessageChannelMessageAssociations =
      await this.utils.getMessageChannelMessageAssociations(
        messageExternalIds,
        gmailMessageChannelId,
        dataSourceMetadata,
        workspaceDataSource,
      );

    const existingMessageChannelMessageAssociationsExternalIds =
      existingMessageChannelMessageAssociations.map(
        (messageChannelMessageAssociation) =>
          messageChannelMessageAssociation.messageExternalId,
      );

    const messagesToFetch = messageExternalIds.filter(
      (messageExternalId) =>
        !existingMessageChannelMessageAssociationsExternalIds.includes(
          messageExternalId,
        ),
    );

    const messageQueries =
      this.utils.createQueriesFromMessageIds(messagesToFetch);

    const { messages: messagesToSave, errors } =
      await this.fetchMessagesByBatchesService.fetchAllMessages(
        messageQueries,
        accessToken,
      );

    if (messagesToSave.length === 0) {
      return;
    }

    await this.utils.saveMessages(
      messagesToSave,
      dataSourceMetadata,
      workspaceDataSource,
      connectedAccount,
      gmailMessageChannelId,
    );

    if (errors.length) throw new Error('Error fetching messages');

    const lastModifiedMessageId = messagesToFetch[0];

    const historyId = messagesToSave.find(
      (message) => message.externalId === lastModifiedMessageId,
    )?.historyId;

    if (!historyId) throw new Error('No history id found');

    await this.utils.saveLastSyncHistoryId(
      historyId,
      connectedAccount.id,
      dataSourceMetadata,
      workspaceDataSource,
    );

    if (messages.data.nextPageToken) {
      await this.messageQueueService.add<GmailFullSyncJobData>(
        GmailFullSyncJob.name,
        {
          workspaceId,
          connectedAccountId,
          nextPageToken: messages.data.nextPageToken,
        },
        {
          id: `${workspaceId}-${connectedAccountId}`,
          retryLimit: 2,
        },
      );
    }
  }
}
