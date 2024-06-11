import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { prisma } from "../client";

async function getAllUsers({ usersId, select }: { usersId?: string[], select?: string[] }) {
	try {
		const query = {
			select: select ? { ...select.reduce((acc, field) => ({ ...acc, [field]: true }), {}) } : undefined,
			where: usersId ? { clerkId: { in: usersId } } : undefined,
		};

		const data = await prisma.user.findMany(query);
		return data;
	} catch (error) {
		console.log(error)
		return null
	}
}

export const postRouter = createTRPCRouter({
	releaseResult: publicProcedure
		.input(z.any())
		.mutation(async (opts: any) => {
			console.time('total');
			// Get data from Supabase
			const awards = await prisma.award.findMany();

			// Inputs
			const week = opts.input.week;
			const splitId = opts.input.splitId;

			// Get data from Supabase
			const participations = await prisma.participation.findMany({
				where: {
					League: {
						week: week,
						splitId: splitId,
					},
				},
				include: {
					League: true,
					UserTeam: {
						include: {
							Player: true,
						},
					},
					Player: true,
				},
			});

			const players = await prisma.player.findMany({
				where: {
					round: null,
					splitId: splitId,
					week: week,
				},
				orderBy: {
					id: 'desc',
				}
			})

			// Map participations
			const updatedParticipations = participations?.map((participation: any) => {
				let score = 0;
				const captain = participation.Player.name.toLowerCase();

				// Get the name of the user team players and find the updated score of the players
				const userTeam = participation.UserTeam.map((player: any) => {
					const name = player.Player.name.toLowerCase();
					const updatedPlayer = players?.find((player: any) => player.name.toLowerCase() === name); // Get the updated player

					if (updatedPlayer === undefined) {
						throw { message: JSON.stringify({ error: 'player_not_found', message: `O jogador ${name} não foi encontrado no banco de dados.` }) };
					}

					return updatedPlayer;

				});

				// Calculate the participant score
				userTeam.map((player: any) => {
					let playerScore = player.score
					score += (playerScore * (captain === player.name.toLowerCase() ? 1.5 : 1)) / 5;
				});

				return { ...participation, point: Number(score.toFixed(2)) };
			}).sort((a: any, b: any) => b.point - a.point);

			// Get all the unique leagueId
			let leagueIds: any = new Set()
			if (updatedParticipations) {
				for (let participation of updatedParticipations) {
					leagueIds.add(participation.leagueId);
				}
			}

			leagueIds = Array.from(leagueIds)

			// Insert data
			if (leagueIds) {
				var transactions: any = [];
				const userAwardsMoney: any = {};
				const userAwardsBonus: any = {};

				leagueIds.map((leagueId: any) => {
					const participationsInALeague = updatedParticipations?.filter((participation: any) => participation.leagueId === leagueId)
					var lastPosition = 1;
					var lastScore;
					const participants: any = [];

					for (let index = 0; index < participationsInALeague!.length; index++) {
						const participation = participationsInALeague![index];
						var position = index + 1;
						const score = participation.point;

						if (lastScore == score) {
							position = lastPosition
						}

						lastPosition = position;
						lastScore = score;

						participants.push({ id: participation.id, position: position, score: score, clerkId: participation.userId, award: null, payment: participation.payment })
					}

					const awardsInLeague = awards?.filter((award: any) => award.leagueId === leagueId) || []

					const participationsWithAwards = participants.map((participation: any) => {
						const clerkId = participation.clerkId;
						const position = participation.position;
						const paymentMethod = participation.payment;
						var money = 0;
						var bonus = 0;

						const drawsQuantity = participants.filter((award: any) => award.position == position).length;
						const award = Math.floor((awardsInLeague.filter((award: any) => award.position >= position && award.position < position + drawsQuantity).reduce((sum: any, award: any) => sum += award.award, 0) / drawsQuantity) * 100) / 100;

						// Update money
						if (paymentMethod == 'money') {
							if (userAwardsMoney[clerkId]) {
								userAwardsMoney[clerkId] += award;
							} else {
								userAwardsMoney[clerkId] = award;
							}
							money = award;
						} else if (paymentMethod == 'bonus') {
							if (userAwardsBonus[clerkId]) {
								userAwardsBonus[clerkId] += award;
							} else {
								userAwardsBonus[clerkId] = award;
							}
							bonus = award;
						} else if (paymentMethod == 'mixed') {
							if (userAwardsMoney[clerkId]) {
								userAwardsMoney[clerkId] += award / 2;
							} else {
								userAwardsMoney[clerkId] = award / 2;
							}

							if (userAwardsBonus[clerkId]) {
								userAwardsBonus[clerkId] += award / 2;
							} else {
								userAwardsBonus[clerkId] = award / 2;
							}
							money = award / 2;
							bonus = award / 2;
						}

						return { ...participation, money: money, bonus: bonus }
					})

					// Add requests to transaction list
					const notificationsData: any = [];
					const moneyTransactions: any = [];
					const bonusTransactions: any = [];

					participationsWithAwards.map((participation: any) => {
						// Update participations
						transactions.push(prisma.participation.update({
							where: { id: participation.id },
							data: {
								point: participation.score,
								money: participation.money,
								bonus: participation.bonus,
								position: participation.position,
							},
						}));

						// Add balances transactions (money and bonus)
						if (participation.money || participation.bonus) {
							if (participation.payment == 'money') {
								moneyTransactions.push({
									value: participation.money,
									type: 'league_award',
									clerkId: participation.clerkId,
								});
							} else if (participation.payment == 'bonus') {
								bonusTransactions.push({
									value: participation.bonus,
									type: 'league_award',
									clerkId: participation.clerkId,
								});
							} else if (participation.payment == 'mixed') {
								moneyTransactions.push({
									value: participation.money,
									type: 'league_award',
									clerkId: participation.clerkId,
								});

								bonusTransactions.push({
									value: participation.bonus,
									type: 'league_award',
									clerkId: participation.clerkId,
								});
							}
						}

						// Add notifications
						notificationsData.push({ userId: participation.clerkId, message: 'Teste not', read: false });
					});

					// Create notifications
					transactions.push(prisma.notification.createMany({
						data: notificationsData,
					}));

					// Add balances transactions
					transactions.push(prisma.moneyTransaction.createMany({
						data: moneyTransactions,
					}));

					// Add balances transactions
					transactions.push(prisma.bonusTransaction.createMany({
						data: bonusTransactions,
					}));
				});

				const userAwardsMoneyList = Object.keys(userAwardsMoney).map((key: string) => {
					return {
						clerkId: key,
						value: userAwardsMoney[key]
					};
				});

				const userAwardsBonusList = Object.keys(userAwardsBonus).map((key: string) => {
					return {
						clerkId: key,
						value: userAwardsBonus[key]
					};
				});

				const usersBalance = await getAllUsers({
					usersId: [...userAwardsMoneyList?.map((user: any) => user.clerkId), ...userAwardsBonusList?.map((user: any) => user.clerkId)],
					select: ['clerkId', 'money', 'bonus'],
				});

				userAwardsMoneyList.map((userAward: any) => {
					const previousMoney = usersBalance?.find((user: any) => user.clerkId == userAward.clerkId)?.money;
					const newMoney = previousMoney + userAward.value;
					transactions.push(prisma.user.update({
						where: { clerkId: userAward.clerkId },
						data: {
							money: newMoney,
						},
					}));
				});

				userAwardsBonusList.map((userAward: any) => {
					const previousBonus = usersBalance?.find((user: any) => user.clerkId == userAward.clerkId)?.bonus;
					const newBonus = previousBonus + userAward.value;
					transactions.push(prisma.user.update({
						where: { clerkId: userAward.clerkId },
						data: {
							bonus: newBonus,
						},
					}));
				});

				const promises = transactions.map(async (transaction: any) => {
					const result = await transaction;
					return result;
				})

				await Promise.all(promises);
			}

			console.timeEnd('total');

			return 'ok';
		}),
});
