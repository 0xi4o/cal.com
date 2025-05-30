import { scheduleEmailReminder } from "@calcom/features/ee/workflows/lib/reminders/emailReminderManager";
import { scheduleSMSReminder } from "@calcom/features/ee/workflows/lib/reminders/smsReminderManager";
import { scheduleWhatsappReminder } from "@calcom/features/ee/workflows/lib/reminders/whatsappReminderManager";
import { getBookerBaseUrl } from "@calcom/lib/getBookerUrl/server";
import { WorkflowRepository } from "@calcom/lib/server/repository/workflow";
import { getTimeFormatStringFromUserTimeFormat } from "@calcom/lib/timeFormat";
import { prisma } from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/client";
import { MembershipRole, SchedulingType, WorkflowActions, WorkflowTriggerEvents } from "@calcom/prisma/enums";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import { TRPCError } from "@trpc/server";

import type { TActivateEventTypeInputSchema } from "./activateEventType.schema";
import { removeSmsReminderFieldForEventTypes, upsertSmsReminderFieldForEventTypes } from "./util";

type ActivateEventTypeOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TActivateEventTypeInputSchema;
};

export const activateEventTypeHandler = async ({ ctx, input }: ActivateEventTypeOptions) => {
  const { eventTypeId, workflowId } = input;

  // Check that event type belong to the user or team
  const userEventType = await prisma.eventType.findFirst({
    where: {
      id: eventTypeId,
      OR: [
        { userId: ctx.user.id },
        {
          team: {
            members: {
              some: {
                userId: ctx.user.id,
                accepted: true,
                NOT: {
                  role: MembershipRole.MEMBER,
                },
              },
            },
          },
        },
      ],
    },
    select: {
      teamId: true,
      children: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!userEventType)
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authorized to edit this event type" });

  // Check that the workflow belongs to the user or team
  const eventTypeWorkflow = await prisma.workflow.findFirst({
    where: {
      id: workflowId,
      OR: [
        {
          userId: ctx.user.id,
        },
        {
          teamId: userEventType.teamId || undefined,
        },
      ],
    },
    select: {
      steps: {
        select: {
          id: true,
          action: true,
          sendTo: true,
          numberRequired: true,
          template: true,
          sender: true,
          emailSubject: true,
          reminderBody: true,
          verifiedAt: true,
        },
      },
      trigger: true,
      time: true,
      timeUnit: true,
      isActiveOnAll: true,
      teamId: true,
      userId: true,
      team: {
        select: {
          isOrganization: true,
        },
      },
    },
  });

  if (!eventTypeWorkflow)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not authorized to enable/disable this workflow",
    });

  //check if event type is already active
  const isActive =
    !!(await prisma.workflowsOnEventTypes.findFirst({
      where: {
        workflowId,
        eventTypeId,
      },
    })) || eventTypeWorkflow.isActiveOnAll;

  const isOrg = eventTypeWorkflow.team?.isOrganization ?? false;

  const activeOn = [eventTypeId].concat(userEventType.children.map((ch) => ch.id));

  if (isActive) {
    // disable workflow for this event type & delete all reminders
    const remindersToDelete = await prisma.workflowReminder.findMany({
      where: {
        booking: {
          eventTypeId: eventTypeId,
          userId: ctx.user.id,
        },
        workflowStepId: {
          in: eventTypeWorkflow.steps.map((step) => {
            return step.id;
          }),
        },
      },
      select: {
        id: true,
        referenceId: true,
        method: true,
        scheduled: true,
      },
    });

    await WorkflowRepository.deleteAllWorkflowReminders(remindersToDelete);

    await prisma.workflowsOnEventTypes.deleteMany({
      where: {
        workflowId,
        eventTypeId: { in: [eventTypeId].concat(userEventType.children.map((ch) => ch.id)) },
      },
    });

    if (eventTypeWorkflow.isActiveOnAll) {
      await prisma.workflow.update({
        where: {
          id: workflowId,
        },
        data: {
          isActiveOnAll: false,
        },
      });

      let allEventTypes = [];

      //get all event types of team or user
      if (eventTypeWorkflow.teamId) {
        allEventTypes = await prisma.eventType.findMany({
          where: {
            id: {
              not: eventTypeId,
            },
            teamId: eventTypeWorkflow.teamId,
          },
        });
      } else {
        const allEventTypesWithLocked = await prisma.eventType.findMany({
          where: {
            id: {
              not: eventTypeId,
            },
            userId: eventTypeWorkflow.userId,
          },
        });

        //if workflows are locked on managed event type then don't set user workflow active
        allEventTypes = allEventTypesWithLocked.filter(
          (eventType) =>
            !eventType.parentId ||
            EventTypeMetaDataSchema.parse(eventType.metadata)?.managedEventConfig?.unlockedFields?.workflows
        );
      }

      // activate all event types on the workflow
      for (const eventType of allEventTypes) {
        await prisma.workflowsOnEventTypes.upsert({
          create: {
            workflowId,
            eventTypeId: eventType.id,
          },
          update: {},
          where: {
            workflowId_eventTypeId: {
              eventTypeId: eventType.id,
              workflowId,
            },
          },
        });
      }
    }
    await removeSmsReminderFieldForEventTypes({ activeOnToRemove: activeOn, workflowId, isOrg });
  } else {
    if (
      eventTypeWorkflow.trigger == WorkflowTriggerEvents.BEFORE_EVENT ||
      eventTypeWorkflow.trigger == WorkflowTriggerEvents.AFTER_EVENT
    ) {
      // activate workflow and schedule reminders for existing bookings
      const bookingsForReminders = await prisma.booking.findMany({
        where: {
          OR: [
            { eventTypeId },
            {
              eventType: {
                parentId: eventTypeId,
              },
            },
          ],
          status: BookingStatus.ACCEPTED,
          startTime: {
            gte: new Date(),
          },
        },
        select: {
          metadata: true,
          userId: true,
          smsReminderNumber: true,
          userPrimaryEmail: true,
          startTime: true,
          endTime: true,
          title: true,
          uid: true,
          attendees: {
            select: {
              name: true,
              email: true,
              timeZone: true,
              locale: true,
            },
          },
          eventType: {
            select: {
              schedulingType: true,
              slug: true,
              customReplyToEmail: true,
              hosts: {
                select: {
                  user: {
                    select: {
                      email: true,
                      destinationCalendar: {
                        select: {
                          primaryEmail: true,
                        },
                      },
                    },
                  },
                },
              },
              hideOrganizerEmail: true,
            },
          },
          user: {
            select: {
              name: true,
              email: true,
              timeZone: true,
              locale: true,
              timeFormat: true,
            },
          },
        },
      });

      const bookerUrl = await getBookerBaseUrl(ctx.user.organizationId ?? null);

      for (const booking of bookingsForReminders) {
        const defaultLocale = "en";
        const bookingInfo = {
          uid: booking.uid,
          bookerUrl,
          attendees: booking.attendees.map((attendee) => {
            return {
              name: attendee.name,
              email: attendee.email,
              timeZone: attendee.timeZone,
              language: { locale: attendee.locale || defaultLocale },
            };
          }),
          organizer: booking.user
            ? {
                name: booking.user.name || "",
                email: booking?.userPrimaryEmail ?? booking.user.email,
                timeZone: booking.user.timeZone,
                timeFormat: getTimeFormatStringFromUserTimeFormat(booking.user.timeFormat),
                language: { locale: booking.user.locale || defaultLocale },
              }
            : { name: "", email: "", timeZone: "", language: { locale: "" } },
          startTime: booking.startTime.toISOString(),
          endTime: booking.endTime.toISOString(),
          title: booking.title,
          language: { locale: booking?.user?.locale || defaultLocale },
          hideOrganizerEmail: booking.eventType?.hideOrganizerEmail,
          eventType: {
            slug: booking.eventType?.slug || "",
            schedulingType: booking.eventType?.schedulingType,
            hosts: booking.eventType?.hosts,
          },
          metadata: booking.metadata,
          customReplyToEmail: booking.eventType?.customReplyToEmail,
        };
        for (const step of eventTypeWorkflow.steps) {
          if (
            step.action === WorkflowActions.EMAIL_ATTENDEE ||
            step.action === WorkflowActions.EMAIL_HOST ||
            step.action === WorkflowActions.EMAIL_ADDRESS
          ) {
            let sendTo: string[] = [];

            switch (step.action) {
              case WorkflowActions.EMAIL_HOST:
                sendTo = [bookingInfo.organizer?.email];
                const schedulingType = bookingInfo.eventType?.schedulingType;
                const hosts = bookingInfo.eventType.hosts
                  ?.filter((host) =>
                    bookingInfo.attendees.some((attendee) => host.user.email === attendee.email)
                  )
                  .map(({ user }) => user.destinationCalendar?.primaryEmail ?? user.email);
                if (
                  (schedulingType === SchedulingType.ROUND_ROBIN ||
                    schedulingType === SchedulingType.COLLECTIVE) &&
                  hosts
                ) {
                  sendTo = sendTo.concat(hosts);
                }
                break;
              case WorkflowActions.EMAIL_ATTENDEE:
                sendTo = bookingInfo.attendees
                  .map((attendee) => attendee.email)
                  .filter((email): email is string => !!email);
                break;
              case WorkflowActions.EMAIL_ADDRESS:
                sendTo = step.sendTo ? [step.sendTo] : [];
                break;
            }

            await scheduleEmailReminder({
              evt: bookingInfo,
              triggerEvent: eventTypeWorkflow.trigger,
              action: step.action,
              timeSpan: {
                time: eventTypeWorkflow.time,
                timeUnit: eventTypeWorkflow.timeUnit,
              },
              sendTo,
              emailSubject: step.emailSubject || "",
              emailBody: step.reminderBody || "",
              template: step.template,
              sender: step.sender,
              workflowStepId: step.id,
              verifiedAt: step.verifiedAt,
              userId: eventTypeWorkflow.userId,
              teamId: eventTypeWorkflow.teamId,
            });
          } else if (step.action === WorkflowActions.SMS_NUMBER && step.sendTo) {
            await scheduleSMSReminder({
              evt: bookingInfo,
              reminderPhone: step.sendTo,
              triggerEvent: eventTypeWorkflow.trigger,
              action: step.action,
              timeSpan: {
                time: eventTypeWorkflow.time,
                timeUnit: eventTypeWorkflow.timeUnit,
              },
              message: step.reminderBody || "",
              workflowStepId: step.id,
              template: step.template,
              sender: step.sender,
              userId: booking.userId,
              teamId: eventTypeWorkflow.teamId,
              verifiedAt: step.verifiedAt,
            });
          } else if (step.action === WorkflowActions.WHATSAPP_NUMBER && step.sendTo) {
            await scheduleWhatsappReminder({
              evt: bookingInfo,
              reminderPhone: step.sendTo,
              triggerEvent: eventTypeWorkflow.trigger,
              action: step.action,
              timeSpan: {
                time: eventTypeWorkflow.time,
                timeUnit: eventTypeWorkflow.timeUnit,
              },
              message: step.reminderBody || "",
              workflowStepId: step.id,
              template: step.template,
              userId: booking.userId,
              teamId: eventTypeWorkflow.teamId,
              verifiedAt: step.verifiedAt,
            });
          } else if (booking.smsReminderNumber) {
            if (step.action === WorkflowActions.SMS_ATTENDEE) {
              await scheduleSMSReminder({
                evt: bookingInfo,
                reminderPhone: booking.smsReminderNumber,
                triggerEvent: eventTypeWorkflow.trigger,
                action: step.action,
                timeSpan: {
                  time: eventTypeWorkflow.time,
                  timeUnit: eventTypeWorkflow.timeUnit,
                },
                message: step.reminderBody || "",
                workflowStepId: step.id,
                template: step.template,
                sender: step.sender,
                userId: booking.userId,
                teamId: eventTypeWorkflow.teamId,
                verifiedAt: step.verifiedAt,
              });
            } else if (step.action === WorkflowActions.WHATSAPP_ATTENDEE) {
              await scheduleWhatsappReminder({
                evt: bookingInfo,
                reminderPhone: booking.smsReminderNumber,
                triggerEvent: eventTypeWorkflow.trigger,
                action: step.action,
                timeSpan: {
                  time: eventTypeWorkflow.time,
                  timeUnit: eventTypeWorkflow.timeUnit,
                },
                message: step.reminderBody || "",
                workflowStepId: step.id,
                template: step.template,
                sender: step.sender,
                userId: booking.userId,
                teamId: eventTypeWorkflow.teamId,
                verifiedAt: step.verifiedAt,
              });
            }
          }
        }
      }
    }

    await prisma.workflowsOnEventTypes.createMany({
      data: [
        {
          workflowId,
          eventTypeId,
        },
      ].concat(userEventType.children.map((ch) => ({ workflowId, eventTypeId: ch.id }))),
    });
    const requiresAttendeeNumber = (action: WorkflowActions) =>
      action === WorkflowActions.SMS_ATTENDEE || action === WorkflowActions.WHATSAPP_ATTENDEE;

    if (eventTypeWorkflow.steps.some((step) => requiresAttendeeNumber(step.action))) {
      const isSmsReminderNumberRequired = eventTypeWorkflow.steps.some((step) => {
        return requiresAttendeeNumber(step.action) && step.numberRequired;
      });

      await upsertSmsReminderFieldForEventTypes({ activeOn, workflowId, isSmsReminderNumberRequired, isOrg });
    }
  }
};
